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

const hookEnv = settings.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.env ?? {};
const sessionId = hookEnv.SESSHIN_SESSION_ID ?? 'stub-session';

const cwd = process.cwd();
const encoded = cwd.replaceAll('/', '-').replaceAll('.', '-');
const sessionFile = join(homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
mkdirSync(dirname(sessionFile), { recursive: true });

function fireHook(event, payload) {
  const cmd = (settings.hooks[event]?.[0]?.hooks?.[0]?.command ?? '').split(' ');
  if (cmd.length === 0 || !cmd[0]) return;
  const env = { ...process.env, ...(settings.hooks[event][0].hooks[0].env ?? {}) };
  spawnSync(cmd[0], cmd.slice(1), { input: JSON.stringify(payload), env, encoding: 'utf-8' });
}

function writeJsonl(line) { appendFileSync(sessionFile, JSON.stringify(line) + '\n'); }

const prompt = argv.find((a) => !a.startsWith('-') && a !== settingsPath) ?? 'do a thing';
fireHook('SessionStart', { hook_event_name: 'SessionStart' });
writeJsonl({ type: 'user', message: { content: prompt }, timestamp: new Date().toISOString() });
fireHook('UserPromptSubmit', { hook_event_name: 'UserPromptSubmit', prompt });

setTimeout(() => {
  fireHook('PreToolUse',  { hook_event_name: 'PreToolUse',  tool_name: 'Read', tool_input: { path: '/etc/hosts' } });
  fireHook('PostToolUse', { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_response: 'localhost' });
  process.stdout.write('I will respond now. Confirm? (y/n) ');
  process.stdin.once('data', (buf) => {
    const got = buf.toString().trim();
    writeJsonl({ type: 'assistant', message: { content: `You said: ${got}` }, timestamp: new Date().toISOString() });
    fireHook('Stop', { hook_event_name: 'Stop', stop_reason: 'end_turn' });
    fireHook('SessionEnd', { hook_event_name: 'SessionEnd' });
    process.exit(0);
  });
}, 200);
