#!/usr/bin/env node
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import WS from 'ws';

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB_CLAUDE = join(HERE, 'stub-claude', 'index.mjs');
const ROOT = join(HERE, '..', '..');
const HUB_BIN  = join(ROOT, 'packages/hub/bin/sesshin-hub');
const CLI_BIN  = join(ROOT, 'packages/cli/bin/sesshin');
const HOOK_BIN = join(ROOT, 'packages/hook-handler/bin/sesshin-hook-handler');

// Only kill hubs that were spawned BY e2e runs (current or previous). Earlier
// versions killed any process whose cmdline contained "sesshin-hub" — that
// over-killed users' real running hubs in the same shell, taking down their
// REST/WS listen sockets. e2e hubs have HOME pointing into our per-run
// tmpdir (set below); real user hubs have HOME under the user's home dir.
// Scope the kill via /proc/<pid>/environ.
//
// Linux-only: macOS/Windows have no /proc, so this becomes a silent no-op
// there. With this PR's shutdown fix landing, leaked hubs are rare enough
// that the no-op is acceptable; investing in a cross-platform process-env
// discovery (lsof/ps -E + parsing) is YAGNI for a Linux-only test env.
function killLeftoverHubs() {
  if (process.platform !== 'linux') return;
  // Build the prefix at runtime so $TMPDIR is honored (default /tmp on
  // Linux but configurable). Trailing slash + 'sesshin-e2e-' matches our
  // mkdtempSync template below.
  const e2eHomePrefix = `HOME=${tmpdir()}/sesshin-e2e-`;
  try {
    const out = execSync('ps -eo pid,args').toString();
    for (const line of out.split('\n')) {
      if (!line.includes('sesshin-hub') || line.includes('grep')) continue;
      const m = line.trim().match(/^(\d+)/);
      if (!m) continue;
      const pid = Number(m[1]);
      // Read environ to confirm this hub belongs to a (previous) e2e run.
      // /proc/<pid>/environ may be unreadable (perms, race) — skip rather
      // than risk a misfire.
      let environ = '';
      try { environ = readFileSync(`/proc/${pid}/environ`, 'utf-8'); } catch { continue; }
      const home = environ.split('\0').find((kv) => kv.startsWith('HOME='));
      if (!home) continue;
      if (!home.startsWith(e2eHomePrefix)) continue;
      try { process.kill(pid); } catch {}
    }
  } catch {}
}

// Kill any leftover hub from previous runs.
killLeftoverHubs();
await new Promise((r) => setTimeout(r, 500));

const tmp = mkdtempSync(join(tmpdir(), 'sesshin-e2e-'));
const env = {
  ...process.env,
  SESSHIN_HUB_BIN: HUB_BIN,
  SESSHIN_HOOK_HANDLER_BIN: HOOK_BIN,
  SESSHIN_CLAUDE_BIN: STUB_CLAUDE,
  SESSHIN_SUMMARIZER: 'heuristic',
  HOME: tmp,        // isolate ~/.claude/, ~/.cache/sesshin/
  // Force a deterministic POSIX shell for the inner shell sesshin-cli spawns.
  // Without this, e2e picks whatever the developer's $SHELL is (zsh / fish /
  // ...) and the empty HOME triggers first-run interactive setup wizards
  // (e.g. zsh-newuser-install) that block the claude command.
  SHELL: '/bin/sh',
};

function fail(msg, extra = null) {
  console.error(msg);
  if (extra) console.error(JSON.stringify(extra, null, 2));
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}

async function main() {
  const cli = spawn('node', [CLI_BIN, 'claude', 'do a thing'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  let cliOut = '';
  cli.stdout.on('data', (d) => { cliOut += d; });

  // wait for hub to be up
  let hubUp = false;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch('http://127.0.0.1:9663/api/health'); if (r.ok) { hubUp = true; break; } } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!hubUp) fail('hub failed to come up within 10s');

  // discover this run's session. Old e2e logic assumed there would be exactly
  // one live session in the hub, which flakes if a prior run leaked a session
  // briefly before teardown. Prefer the newest session for this cwd.
  let sid = null;
  for (let i = 0; i < 50; i++) {
    const list = await (await fetch('http://127.0.0.1:9663/api/sessions')).json();
    const matches = list.filter((s) => s.cwd === ROOT);
    if (matches.length >= 1) {
      matches.sort((a, b) => b.startedAt - a.startedAt);
      sid = matches[0].id;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!sid) fail('no session registered within 5s');

  const current = await (await fetch('http://127.0.0.1:9663/api/sessions')).json();
  const matching = current.filter((s) => s.cwd === ROOT);
  if (matching.length > 1) {
    matching.sort((a, b) => b.startedAt - a.startedAt);
    if (matching[0]?.id !== sid) fail('selected session is not the newest matching session');
  }

  // open WS, capture events
  const ws = new WS('ws://127.0.0.1:9662/v1/ws');
  const got = { events: [], summary: false, state: null, confirmations: [], confirmationResolved: 0, messages: [] };
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.send(JSON.stringify({ type: 'client.identify', protocol: 1, client: { kind: 'debug-web', version: '0', capabilities: ['summary','events','state','actions'] } }));
  ws.send(JSON.stringify({ type: 'subscribe', sessions: 'all', since: null }));
  ws.on('message', (m) => {
    const msg = JSON.parse(m.toString());
    got.messages.push(msg);
    if (msg.type === 'session.event')   got.events.push(msg);
    if (msg.type === 'session.summary') got.summary = true;
    if (msg.type === 'session.state')   got.state = msg.state;
    if (msg.type === 'session.prompt-request') {
      got.confirmations.push(msg);
      // Verify the PermissionRequest path: respond with 'allow'. The hub
      // must release the pending approval with this decision.
      ws.send(JSON.stringify({
        type: 'prompt-response',
        sessionId: msg.sessionId, requestId: msg.requestId,
        answers: [{ questionIndex: 0, selectedKeys: ['yes'], freeText: 'e2e: auto-approve' }],
      }));
    }
    if (msg.type === 'session.prompt-request.resolved') got.confirmationResolved += 1;
  });

  // Wait until the remote approval has resolved AND the stub's prompt is
  // visible before sending literal input back into Claude's PTY. Sending the
  // text too early races the approval release and can get dropped. In practice
  // the prompt can be visible slightly before the child process has fully
  // armed its stdin listener, so hold one extra beat after the prompt becomes
  // visible to avoid a lost write.
  await new Promise((res, rej) => {
    const start = Date.now();
    let promptVisibleAt = null;
    const t = setInterval(() => {
      const promptShown = cliOut.includes('Confirm? (y/n)');
      const approvalResolved = got.confirmationResolved > 0;
      const stateOk = got.state === 'idle' || got.state === 'awaiting-input' || got.state === 'awaiting-confirmation';
      if (promptShown && promptVisibleAt === null) promptVisibleAt = Date.now();
      const promptSettled = promptVisibleAt !== null && (Date.now() - promptVisibleAt) >= 250;
      if (approvalResolved && stateOk && promptSettled) { clearInterval(t); res(); }
      else if (Date.now() - start > 15000) {
        clearInterval(t);
        rej(new Error(`timeout waiting for prompt+approval+state. promptShown=${promptShown} approvalResolved=${approvalResolved} state=${got.state} cliOut:\n${cliOut}`));
      }
    }, 50);
  });
  // Send a literal "y\r" via input.text — equivalent to the old action:'approve'
  // (which mapped to "y\r" in actionToInput). approve/reject/continue were
  // removed in cleanup; only `stop` (ESC) remains as a TTY shortcut, since
  // ESC isn't typeable through input.text trivially.
  ws.send(JSON.stringify({ type: 'input.text', sessionId: sid, text: 'y\r' }));
  await new Promise((r) => setTimeout(r, 50));
  ws.send(JSON.stringify({ type: 'input.text', sessionId: sid, text: 'y\r' }));

  // wait for cli exit (with timeout)
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('cli did not exit within 10s; cliOut:\n' + cliOut)), 10000);
    cli.on('exit', () => { clearTimeout(t); res(); });
  });

  // give the hub time to drain final events / summary. The summary may arrive
  // after SessionEnd/session.removed because it is debounced and can fall back
  // through multiple summarizer modes before broadcasting.
  await new Promise((r) => setTimeout(r, 3000));

  // assertions
  if (!got.summary)             fail('no session.summary received', { state: got.state, confirmationResolved: got.confirmationResolved, cliOut, messageTypes: got.messages.map((m) => m.type), messages: got.messages.slice(-20) });
  if (got.events.length === 0)  fail('no session.event received');
  if (got.state !== null && got.state !== 'idle' && got.state !== 'done') fail(`unexpected final state: ${got.state}`);
  if (!cliOut.includes('You said: y')) fail(`stub-claude did not see "y": output was:\n${cliOut}`);
  if (got.confirmations.length === 0)  fail('no session.prompt-request received (path B never engaged)');
  if (got.confirmationResolved === 0)  fail('no session.prompt-request.resolved received after we approved');

  console.log('e2e PASS');
  ws.close();
  rmSync(tmp, { recursive: true, force: true });
  killLeftoverHubs();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  rmSync(tmp, { recursive: true, force: true });
  killLeftoverHubs();
  process.exit(1);
});
