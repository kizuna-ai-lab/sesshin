import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const HANDLER = join(HERE, '../dist/main.js');

function startFakeHub(opts: { delayMs?: number; respondStatus?: number; respondBody?: string; respondContentType?: string } = {}) {
  return new Promise<{ port: number; received: any[]; close: () => void }>((resolve) => {
    const received: any[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      try { received.push(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); } catch { /* */ }
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      res.writeHead(opts.respondStatus ?? 200, { 'content-type': opts.respondContentType ?? 'application/json' });
      res.end(opts.respondBody ?? '');
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      resolve({ port, received, close: () => server.close() });
    });
  });
}

function runHandler(args: { hubUrl: string; sessionId: string; nativeEvent: string; stdin: string }) {
  return new Promise<{ code: number; durationMs: number; stdout: string; stderr: string }>((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [HANDLER, args.nativeEvent], {
      env: {
        ...process.env,
        SESSHIN_HUB_URL: args.hubUrl,
        SESSHIN_SESSION_ID: args.sessionId,
        SESSHIN_AGENT: 'claude-code',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.end(args.stdin);
    child.on('exit', (code) => resolve({ code: code ?? 0, durationMs: Date.now() - t0, stdout, stderr }));
  });
}

describe('hook-handler binary — fire-and-forget events', () => {
  it('POSTs the event JSON to the hub', async () => {
    const hub = await startFakeHub({ respondStatus: 204 });
    const r = await runHandler({
      hubUrl: `http://127.0.0.1:${hub.port}`,
      sessionId: 'sid-test',
      nativeEvent: 'Stop',
      stdin: JSON.stringify({ session_id: 'cc-uuid-1' }),
    });
    hub.close();
    expect(r.code).toBe(0);
    expect(hub.received).toHaveLength(1);
    expect(hub.received[0]).toMatchObject({
      agent: 'claude-code',
      sessionId: 'sid-test',
      event: 'Stop',
      raw: { nativeEvent: 'Stop', session_id: 'cc-uuid-1' },
    });
  });

  it('exits 0 within 350ms even when hub is slow (250ms timeout)', async () => {
    const hub = await startFakeHub({ delayMs: 5000, respondStatus: 204 });
    const r = await runHandler({
      hubUrl: `http://127.0.0.1:${hub.port}`,
      sessionId: 's', nativeEvent: 'Stop', stdin: '{}',
    });
    hub.close();
    expect(r.code).toBe(0);
    expect(r.durationMs).toBeLessThan(800); // generous cushion above 250ms
  });

  it('exits 0 even when hub returns 500', async () => {
    const hub = await startFakeHub({ respondStatus: 500 });
    const r = await runHandler({
      hubUrl: `http://127.0.0.1:${hub.port}`,
      sessionId: 's', nativeEvent: 'Stop', stdin: '{}',
    });
    hub.close();
    expect(r.code).toBe(0);
  });

  it('exits 0 when hub URL is unreachable', async () => {
    const r = await runHandler({
      hubUrl: 'http://127.0.0.1:1', sessionId: 's', nativeEvent: 'Stop', stdin: '{}',
    });
    expect(r.code).toBe(0);
  });

  it('emits empty stdout for non-PreToolUse events', async () => {
    const hub = await startFakeHub({ respondStatus: 204 });
    const r = await runHandler({
      hubUrl: `http://127.0.0.1:${hub.port}`,
      sessionId: 's', nativeEvent: 'Stop', stdin: '{}',
    });
    hub.close();
    expect(r.stdout).toBe('');
  });
});

describe('hook-handler binary — PreToolUse approval flow', () => {
  it('forwards the hub\'s decision JSON unchanged to stdout', async () => {
    const decision = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'remote user said no',
      },
    };
    const hub = await startFakeHub({ respondStatus: 200, respondBody: JSON.stringify(decision) });
    const r = await runHandler({
      hubUrl: `http://127.0.0.1:${hub.port}`,
      sessionId: 's', nativeEvent: 'PreToolUse',
      stdin: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
    });
    hub.close();
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(decision);
  });

  it('falls back to "ask" when the hub is unreachable so claude\'s TUI handles it', async () => {
    const r = await runHandler({
      hubUrl: 'http://127.0.0.1:1', sessionId: 's', nativeEvent: 'PreToolUse',
      stdin: JSON.stringify({ tool_name: 'Bash', tool_input: {} }),
    });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('ask');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('hub unreachable');
  });

  it('falls back to "ask" when the hub returns malformed JSON', async () => {
    const hub = await startFakeHub({ respondStatus: 200, respondBody: 'not json' });
    const r = await runHandler({
      hubUrl: `http://127.0.0.1:${hub.port}`,
      sessionId: 's', nativeEvent: 'PreToolUse',
      stdin: JSON.stringify({ tool_name: 'Bash', tool_input: {} }),
    });
    hub.close();
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('ask');
  });

  it('emits empty stdout when the hub passes through with 204 (auto mode / non-gated tool)', async () => {
    // Critical: claude must follow its normal mode logic in this case.
    // ANY JSON output (even "ask") would override that logic and produce
    // an unwanted prompt in auto / acceptEdits / bypassPermissions mode.
    const hub = await startFakeHub({ respondStatus: 204 });
    const r = await runHandler({
      hubUrl: `http://127.0.0.1:${hub.port}`,
      sessionId: 's', nativeEvent: 'PreToolUse',
      stdin: JSON.stringify({ permission_mode: 'auto', tool_name: 'Read', tool_input: { path: '/etc/hosts' } }),
    });
    hub.close();
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
  });
});
