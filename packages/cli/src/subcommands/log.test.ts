import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLog } from './log.js';
import { createServer, type Server } from 'node:http';

let stub: Server;
let port: number;
let writes: string[];
let errs: string[];
let origStdoutWrite: typeof process.stdout.write;
let origStderrWrite: typeof process.stderr.write;
let origHubUrl: string | undefined;
let tmp: string;

beforeEach(async () => {
  writes = []; errs = [];
  origStdoutWrite = process.stdout.write.bind(process.stdout);
  origStderrWrite = process.stderr.write.bind(process.stderr);
  // Capture writes so the test can assert on output.
  // Cast through unknown — process.stdout.write has many overloads.
  (process.stdout.write as unknown) = (chunk: unknown): boolean => {
    writes.push(String(chunk));
    return true;
  };
  (process.stderr.write as unknown) = (chunk: unknown): boolean => {
    errs.push(String(chunk));
    return true;
  };
  origHubUrl = process.env['SESSHIN_HUB_URL'];
  tmp = mkdtempSync(join(tmpdir(), 'sesshin-log-test-'));
});

afterEach(async () => {
  (process.stdout.write as unknown) = origStdoutWrite;
  (process.stderr.write as unknown) = origStderrWrite;
  if (origHubUrl === undefined) delete process.env['SESSHIN_HUB_URL'];
  else process.env['SESSHIN_HUB_URL'] = origHubUrl;
  delete process.env['SESSHIN_SESSION_ID'];
  if (stub) await new Promise<void>((res) => stub.close(() => res()));
  rmSync(tmp, { recursive: true, force: true });
});

function stubDiagnostics(sessions: Array<{ id: string; sessionFilePath?: string }>): Promise<void> {
  return new Promise((resolve) => {
    stub = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sessions }));
    });
    stub.listen(0, '127.0.0.1', () => {
      const addr = stub.address();
      port = typeof addr === 'object' && addr ? addr.port : 0;
      process.env['SESSHIN_HUB_URL'] = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

describe('runLog — default: print path', () => {
  it('prints just the path on stdout when one matching session', async () => {
    await stubDiagnostics([{ id: 'abc', sessionFilePath: '/path/x.jsonl' }]);
    const code = await runLog({});
    expect(code).toBe(0);
    expect(writes.join('')).toBe('/path/x.jsonl\n');
  });
  it('respects --session', async () => {
    await stubDiagnostics([
      { id: 'abc', sessionFilePath: '/a.jsonl' },
      { id: 'def', sessionFilePath: '/d.jsonl' },
    ]);
    const code = await runLog({ sessionId: 'def' });
    expect(code).toBe(0);
    expect(writes.join('')).toBe('/d.jsonl\n');
  });
  it('falls back to SESSHIN_SESSION_ID env', async () => {
    await stubDiagnostics([
      { id: 'abc', sessionFilePath: '/a.jsonl' },
      { id: 'def', sessionFilePath: '/d.jsonl' },
    ]);
    process.env['SESSHIN_SESSION_ID'] = 'abc';
    const code = await runLog({});
    expect(code).toBe(0);
    expect(writes.join('')).toBe('/a.jsonl\n');
  });
  it('--json prints {sessionId, path}', async () => {
    await stubDiagnostics([{ id: 'abc', sessionFilePath: '/p.jsonl' }]);
    const code = await runLog({ json: true });
    expect(code).toBe(0);
    expect(JSON.parse(writes.join(''))).toEqual({ sessionId: 'abc', path: '/p.jsonl' });
  });
});

describe('runLog — error paths', () => {
  it('exit 2 + stderr on no matching session', async () => {
    await stubDiagnostics([{ id: 'abc', sessionFilePath: '/a.jsonl' }]);
    const code = await runLog({ sessionId: 'missing' });
    expect(code).toBe(2);
    expect(errs.join('')).toContain('no session matching missing');
  });
  it('exit 2 on no sessions at all', async () => {
    await stubDiagnostics([]);
    const code = await runLog({});
    expect(code).toBe(2);
    expect(errs.join('')).toContain('no sessions');
  });
  it('exit 3 + lists candidates when 2+ sessions and no filter', async () => {
    await stubDiagnostics([
      { id: 'abc', sessionFilePath: '/a.jsonl' },
      { id: 'def', sessionFilePath: '/d.jsonl' },
    ]);
    const code = await runLog({});
    expect(code).toBe(3);
    const e = errs.join('');
    expect(e).toContain('2 sessions');
    expect(e).toContain('abc');
    expect(e).toContain('def');
  });
  it('exit 4 when matched session has no sessionFilePath', async () => {
    await stubDiagnostics([{ id: 'abc' }]);
    const code = await runLog({ sessionId: 'abc' });
    expect(code).toBe(4);
    expect(errs.join('')).toContain('no transcript path yet');
  });
});

describe('runLog --filter', () => {
  it('prints only lines whose type matches', async () => {
    const path = join(tmp, 'fixt.jsonl');
    writeFileSync(path, [
      '{"type":"user","content":"hi"}',
      '{"type":"permission-mode","permissionMode":"auto"}',
      '{"type":"assistant","content":"yo"}',
      '{"type":"permission-mode","permissionMode":"default"}',
      'not even json',
      '',
      '{"type":"user","content":"bye"}',
    ].join('\n') + '\n');
    await stubDiagnostics([{ id: 'abc', sessionFilePath: path }]);
    const code = await runLog({ filter: 'permission-mode' });
    expect(code).toBe(0);
    const lines = writes.join('').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: 'permission-mode', permissionMode: 'auto' });
    expect(JSON.parse(lines[1]!)).toMatchObject({ type: 'permission-mode', permissionMode: 'default' });
  });
  it('produces no output when nothing matches', async () => {
    const path = join(tmp, 'fixt2.jsonl');
    writeFileSync(path, '{"type":"user"}\n');
    await stubDiagnostics([{ id: 'abc', sessionFilePath: path }]);
    const code = await runLog({ filter: 'permission-mode' });
    expect(code).toBe(0);
    expect(writes.join('')).toBe('');
  });
});

describe('runLog — hub error', () => {
  it('exit 1 when hub returns non-200', async () => {
    stub = createServer((_req, res) => { res.writeHead(503).end(); });
    await new Promise<void>((res) => stub.listen(0, '127.0.0.1', () => res()));
    const addr = stub.address();
    process.env['SESSHIN_HUB_URL'] = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    const code = await runLog({});
    expect(code).toBe(1);
    expect(errs.join('')).toContain('hub error 503');
  });
});
