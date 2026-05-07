import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runPause } from './pause.js';
import { runResume } from './resume.js';
import { runKill } from './kill.js';
import { runRename } from './rename.js';

let writes: string[];
let errs: string[];
let origStdoutWrite: typeof process.stdout.write;
let origStderrWrite: typeof process.stderr.write;

beforeEach(() => {
  writes = []; errs = [];
  origStdoutWrite = process.stdout.write.bind(process.stdout);
  origStderrWrite = process.stderr.write.bind(process.stderr);
  (process.stdout.write as unknown) = (chunk: unknown): boolean => {
    writes.push(String(chunk));
    return true;
  };
  (process.stderr.write as unknown) = (chunk: unknown): boolean => {
    errs.push(String(chunk));
    return true;
  };
});

afterEach(() => {
  (process.stdout.write as unknown) = origStdoutWrite;
  (process.stderr.write as unknown) = origStderrWrite;
});

/**
 * Build a fetch stub that records every call and returns the queued response.
 * Each test enqueues exactly one response and asserts on the recorded call.
 */
function stubFetch(response: { status: number; body?: string }): {
  fetch: typeof globalThis.fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn(async (input: unknown, init?: unknown): Promise<Response> => {
    calls.push({ url: String(input), init: init as RequestInit | undefined });
    return new Response(response.body ?? '', { status: response.status });
  });
  return { fetch: fn as unknown as typeof globalThis.fetch, calls };
}

describe('runPause', () => {
  it('POSTs {action:"pause"} to the right URL and prints "paused" on 200', async () => {
    const { fetch, calls } = stubFetch({ status: 200, body: JSON.stringify({ ok: true }) });
    const code = await runPause({ sessionId: 'abc', hubUrl: 'http://h:9663', fetch });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://h:9663/api/v1/sessions/abc/lifecycle');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ action: 'pause' });
    expect(writes.join('')).toBe('paused\n');
  });

  it('returns 1 + writes "pause failed: <status> <body>" on non-2xx', async () => {
    const { fetch } = stubFetch({ status: 409, body: '{"ok":false,"code":"lifecycle.invalid-state"}' });
    const code = await runPause({ sessionId: 'abc', hubUrl: 'http://h:9663', fetch });
    expect(code).toBe(1);
    expect(errs.join('')).toContain('pause failed: 409');
    expect(errs.join('')).toContain('lifecycle.invalid-state');
  });
});

describe('runResume', () => {
  it('POSTs {action:"resume"} and prints "resumed" on 200', async () => {
    const { fetch, calls } = stubFetch({ status: 200, body: '{"ok":true}' });
    const code = await runResume({ sessionId: 'sX', hubUrl: 'http://h:9663', fetch });
    expect(code).toBe(0);
    expect(calls[0]!.url).toBe('http://h:9663/api/v1/sessions/sX/lifecycle');
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ action: 'resume' });
    expect(writes.join('')).toBe('resumed\n');
  });
});

describe('runKill', () => {
  it('POSTs {action:"kill"} and prints "kill requested" on 200', async () => {
    const { fetch, calls } = stubFetch({ status: 200, body: '{"ok":true}' });
    const code = await runKill({ sessionId: 'sY', hubUrl: 'http://h:9663', fetch });
    expect(code).toBe(0);
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ action: 'kill' });
    expect(writes.join('')).toBe('kill requested\n');
  });
});

describe('runRename', () => {
  it('POSTs {action:"rename", payload:{name}} and prints "renamed to <name>"', async () => {
    const { fetch, calls } = stubFetch({ status: 200, body: '{"ok":true}' });
    const code = await runRename({ sessionId: 'sZ', name: 'fancy name', hubUrl: 'http://h:9663', fetch });
    expect(code).toBe(0);
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      action: 'rename', payload: { name: 'fancy name' },
    });
    expect(writes.join('')).toBe('renamed to fancy name\n');
  });

  it('reports failure with status and body on non-2xx', async () => {
    const { fetch } = stubFetch({ status: 409, body: '{"ok":false,"code":"lifecycle.payload-required"}' });
    const code = await runRename({ sessionId: 'sZ', name: '', hubUrl: 'http://h:9663', fetch });
    expect(code).toBe(1);
    expect(errs.join('')).toContain('rename failed: 409');
    expect(errs.join('')).toContain('lifecycle.payload-required');
  });
});
