import { spawn as nodeSpawn } from 'node:child_process';
import { runRelay, type RelayDeps } from './relay.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

const realSpawn: RelayDeps['spawn'] = (cmd, args, opts) => new Promise((resolve) => {
  const child = nodeSpawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, opts.timeoutMs);
  child.stdout.on('data', (d) => { stdout += d.toString('utf-8'); });
  child.stderr.on('data', (d) => { stderr += d.toString('utf-8'); });
  child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  child.on('error', () => { clearTimeout(timer); resolve({ code: 1, stdout, stderr, timedOut }); });
  child.stdin.write(opts.stdin);
  child.stdin.end();
});

export async function main(): Promise<number> {
  const stdin = await readStdin();
  return runRelay({
    stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env as RelayDeps['env'],
    fetch: globalThis.fetch,
    spawn: realSpawn,
    fastTimeoutMs: 250,
    wrapTimeoutMs: 1500,
  });
}
