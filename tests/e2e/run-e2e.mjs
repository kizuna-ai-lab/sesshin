#!/usr/bin/env node
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import WS from 'ws';

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB_CLAUDE = join(HERE, 'stub-claude', 'index.mjs');
const ROOT = join(HERE, '..', '..');
const HUB_BIN  = join(ROOT, 'packages/hub/bin/sesshin-hub');
const CLI_BIN  = join(ROOT, 'packages/cli/bin/sesshin');
const HOOK_BIN = join(ROOT, 'packages/hook-handler/bin/sesshin-hook-handler');

function killLeftoverHubs() {
  try {
    const out = execSync('ps -eo pid,args').toString();
    for (const line of out.split('\n')) {
      if (line.includes('sesshin-hub') && !line.includes('grep')) {
        const m = line.trim().match(/^(\d+)/);
        if (m) { try { process.kill(Number(m[1])); } catch {} }
      }
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
};

function fail(msg) { console.error(msg); rmSync(tmp, { recursive: true, force: true }); process.exit(1); }

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

  // discover session
  let sid = null;
  for (let i = 0; i < 50; i++) {
    const list = await (await fetch('http://127.0.0.1:9663/api/sessions')).json();
    if (list.length === 1) { sid = list[0].id; break; }
    if (list.length > 1) fail(`expected 1 session, got ${list.length}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!sid) fail('no session registered within 5s');

  // open WS, capture events
  const ws = new WS('ws://127.0.0.1:9662/v1/ws');
  const got = { events: [], summary: false, state: null, confirmations: [], confirmationResolved: 0 };
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.send(JSON.stringify({ type: 'client.identify', protocol: 1, client: { kind: 'debug-web', version: '0', capabilities: ['summary','events','state','actions'] } }));
  ws.send(JSON.stringify({ type: 'subscribe', sessions: 'all', since: null }));
  ws.on('message', (m) => {
    const msg = JSON.parse(m.toString());
    if (msg.type === 'session.event')   got.events.push(msg);
    if (msg.type === 'session.summary') got.summary = true;
    if (msg.type === 'session.state')   got.state = msg.state;
    if (msg.type === 'session.prompt-request') {
      got.confirmations.push(msg);
      // Verify path B: respond with 'allow'. The hub must release the
      // PreToolUse hook handler with this decision.
      ws.send(JSON.stringify({
        type: 'prompt-response',
        sessionId: msg.sessionId, requestId: msg.requestId,
        answers: [{ questionIndex: 0, selectedKeys: ['allow'], freeText: 'e2e: auto-approve' }],
      }));
    }
    if (msg.type === 'session.prompt-request.resolved') got.confirmationResolved += 1;
  });

  // wait until stub-claude prompts for confirmation AND the session state allows input
  await new Promise((res, rej) => {
    const start = Date.now();
    const t = setInterval(() => {
      const promptShown = cliOut.includes('Confirm? (y/n)');
      const stateOk = got.state === 'idle' || got.state === 'awaiting-input' || got.state === 'awaiting-confirmation';
      if (promptShown && stateOk) { clearInterval(t); res(); }
      else if (Date.now() - start > 15000) { clearInterval(t); rej(new Error(`timeout waiting for prompt+state. promptShown=${promptShown} state=${got.state} cliOut:\n${cliOut}`)); }
    }, 50);
  });
  ws.send(JSON.stringify({ type: 'input.action', sessionId: sid, action: 'approve' }));

  // wait for cli exit (with timeout)
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('cli did not exit within 10s; cliOut:\n' + cliOut)), 10000);
    cli.on('exit', () => { clearTimeout(t); res(); });
  });

  // give the hub time to drain final events / summary
  await new Promise((r) => setTimeout(r, 1000));

  // assertions
  if (!got.summary)             fail('no session.summary received');
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
