#!/usr/bin/env node
// A fake `claude` for e2e tests.
import { readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const argv = process.argv.slice(2);
const settingsIdx = argv.indexOf('--settings');
const settingsPath = settingsIdx >= 0 ? argv[settingsIdx + 1] : null;
if (!settingsPath) { process.stderr.write('stub-claude: --settings required\n'); process.exit(2); }
const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));

// Extract env vars baked into the command string via /usr/bin/env VAR=value …
// (claude ignores the per-hook `env` field; we use env-prefix instead.)
function parseEnvPrefix(cmdStr) {
  const parts = (cmdStr ?? '').split(' ');
  const env = {};
  let i = 0;
  if (parts[0] === '/usr/bin/env' || parts[0] === 'env') {
    i = 1;
    while (i < parts.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[i])) {
      const eq = parts[i].indexOf('=');
      env[parts[i].slice(0, eq)] = parts[i].slice(eq + 1);
      i += 1;
    }
  }
  return { env, rest: parts.slice(i) };
}

const startCmd = settings.hooks?.SessionStart?.[0]?.hooks?.[0]?.command ?? '';
const { env: hookEnv } = parseEnvPrefix(startCmd);
const sessionId = hookEnv.SESSHIN_SESSION_ID ?? 'stub-session';
const transcriptPath = (() => {
  const cwd = process.cwd();
  const encoded = cwd.replaceAll('/', '-').replaceAll('.', '-');
  return join(homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
})();

mkdirSync(dirname(transcriptPath), { recursive: true });

function fireHook(event, payload) {
  const cmdStr = settings.hooks[event]?.[0]?.hooks?.[0]?.command ?? '';
  const parts = cmdStr.split(' ');
  if (parts.length === 0 || !parts[0]) return null;
  // Pass through to the binary unchanged. /usr/bin/env handles VAR=val
  // arguments natively, so we don't need to lift them into our own env map.
  const r = spawnSync(parts[0], parts.slice(1), { input: JSON.stringify(payload), env: process.env, encoding: 'utf-8' });
  // For PreToolUse, claude reads stdout for the permission decision.
  if (event === 'PreToolUse') {
    try {
      const out = JSON.parse(r.stdout ?? '');
      const d = out?.hookSpecificOutput?.permissionDecision;
      if (d === 'allow' || d === 'deny' || d === 'ask') return d;
    } catch { /* fall through */ }
    return 'ask';
  }
  return null;
}

function writeJsonl(line) { appendFileSync(transcriptPath, JSON.stringify(line) + '\n'); }

const prompt = argv.find((a) => !a.startsWith('-') && a !== settingsPath) ?? 'do a thing';
fireHook('SessionStart', { hook_event_name: 'SessionStart', session_id: sessionId, transcript_path: transcriptPath, cwd: process.cwd(), source: 'startup' });
writeJsonl({ type: 'user', message: { content: prompt }, timestamp: new Date().toISOString() });
fireHook('UserPromptSubmit', { hook_event_name: 'UserPromptSubmit', prompt });

setTimeout(() => {
  // Use Bash with permission_mode=default so the gate triggers (Read would
  // be auto-allowed by the policy and skip the approval flow entirely).
  const decision = fireHook('PreToolUse', { hook_event_name: 'PreToolUse', permission_mode: 'default', tool_name: 'Bash', tool_input: { command: 'echo hi' }, tool_use_id: 'toolu_stub_1' });
  if (decision === 'deny') {
    fireHook('PostToolUse', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: 'denied by remote approver' });
  } else {
    // 'allow' or 'ask' (laptop TUI auto-approves the stub).
    fireHook('PostToolUse', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: 'hi' });
  }
  // Write an assistant line before prompting so the state machine moves out of `running`.
  writeJsonl({ type: 'assistant', message: { content: 'I will respond now. Confirm? (y/n)' }, timestamp: new Date().toISOString() });
  process.stdout.write('I will respond now. Confirm? (y/n) ');
  process.stdin.once('data', (buf) => {
    const got = buf.toString().trim();
    const reply = `You said: ${got}`;
    process.stdout.write(`\n${reply}\n`);
    writeJsonl({ type: 'assistant', message: { content: reply }, timestamp: new Date().toISOString() });
    fireHook('Stop', { hook_event_name: 'Stop', stop_reason: 'end_turn' });
    fireHook('SessionEnd', { hook_event_name: 'SessionEnd' });
    process.exit(0);
  });
}, 200);
