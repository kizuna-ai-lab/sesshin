import { describe, it, expect, vi } from 'vitest';
import { runRelay, type RelayDeps } from './relay.js';

function makeDeps(overrides: Partial<RelayDeps> = {}): RelayDeps {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const fetched: any[] = [];
  return {
    stdin: '{}',
    stdout: { write: (s: string) => { stdout.push(s); return true; } },
    stderr: { write: (s: string) => { stderr.push(s); return true; } },
    env: { SESSHIN_HUB_URL: 'http://127.0.0.1:9663', SESSHIN_SESSION_ID: 's1' },
    fetch: async (url: string, init?: any) => {
      fetched.push({ url, init });
      return new Response(null, { status: 204 });
    },
    spawn: () => { throw new Error('spawn should not be called when SESSHIN_USER_STATUSLINE_CMD is unset'); },
    fastTimeoutMs: 250,
    wrapTimeoutMs: 1500,
    ...overrides,
    // Re-attach captures so test can assert
    _captured: { stdout, stderr, fetched },
  } as any;
}

describe('runRelay', () => {
  it('POSTs null windows when rate_limits absent and renders nothing (no wrap)', async () => {
    const deps = makeDeps({ stdin: '{"model":"claude-opus","other":1}' });
    const code = await runRelay(deps);
    expect(code).toBe(0);
    expect((deps as any)._captured.fetched[0].init.body)
      .toBe(JSON.stringify({ sessionId: 's1', five_hour: null, seven_day: null }));
    expect((deps as any)._captured.stdout.join('')).toBe('');
  });

  it('POSTs both windows when rate_limits present and renders default', async () => {
    const deps = makeDeps({
      stdin: JSON.stringify({
        rate_limits: {
          five_hour: { used_percentage: 45, resets_at: 100 },
          seven_day: { used_percentage: 23, resets_at: 200 },
        },
      }),
    });
    const code = await runRelay(deps);
    expect(code).toBe(0);
    const body = JSON.parse((deps as any)._captured.fetched[0].init.body);
    expect(body.five_hour.used_percentage).toBe(45);
    expect(body.seven_day.used_percentage).toBe(23);
    expect((deps as any)._captured.stdout.join('')).toBe('5h: 45% · 7d: 23%');
  });

  it('renders empty when rate_limits absent and no wrap configured', async () => {
    const deps = makeDeps({ stdin: '{}' });
    const code = await runRelay(deps);
    expect((deps as any)._captured.stdout.join('')).toBe('');
    expect(code).toBe(0);
  });

  it('partially-present rate_limits POSTs nulls for missing windows', async () => {
    const deps = makeDeps({
      stdin: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 1, resets_at: 1 } } }),
    });
    await runRelay(deps);
    const body = JSON.parse((deps as any)._captured.fetched[0].init.body);
    expect(body.five_hour).toEqual({ used_percentage: 1, resets_at: 1 });
    expect(body.seven_day).toBeNull();
  });

  it('malformed stdin JSON: skips POST, runs wrap if configured, exits 0', async () => {
    const spawnCalls: any[] = [];
    const deps = makeDeps({
      stdin: 'not json',
      env: { SESSHIN_HUB_URL: 'http://x', SESSHIN_SESSION_ID: 's1', SESSHIN_USER_STATUSLINE_CMD: 'echo wrapped' },
      spawn: ((cmd: string, args: string[], opts: any) => {
        spawnCalls.push({ cmd, args, opts });
        return Promise.resolve({ code: 0, stdout: 'wrapped', stderr: '' });
      }) as any,
    });
    const code = await runRelay(deps);
    expect((deps as any)._captured.fetched).toEqual([]);
    expect((deps as any)._captured.stdout.join('')).toBe('wrapped');
    expect(spawnCalls[0].args).toEqual(['-c', 'echo wrapped']);
    expect(code).toBe(0);
  });

  it('hub unreachable: POST aborts, wrap still runs, exits 0', async () => {
    const deps = makeDeps({
      stdin: '{}',
      env: { SESSHIN_HUB_URL: 'http://x', SESSHIN_SESSION_ID: 's1', SESSHIN_USER_STATUSLINE_CMD: 'cat' },
      fetch: async () => { throw new Error('connection refused'); },
      spawn: ((_cmd: string, _args: string[], opts: any) => {
        return Promise.resolve({ code: 0, stdout: 'ok-' + opts.stdin, stderr: '' });
      }) as any,
    });
    const code = await runRelay(deps);
    expect((deps as any)._captured.stdout.join('')).toBe('ok-{}');
    expect(code).toBe(0);
  });

  it('wrap command non-zero exit: falls back to default render, logs to stderr', async () => {
    const deps = makeDeps({
      stdin: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 10, resets_at: 1 }, seven_day: null } }),
      env: { SESSHIN_HUB_URL: 'http://x', SESSHIN_SESSION_ID: 's1', SESSHIN_USER_STATUSLINE_CMD: 'broken' },
      spawn: (() => Promise.resolve({ code: 1, stdout: '', stderr: 'boom' })) as any,
    });
    const code = await runRelay(deps);
    expect((deps as any)._captured.stdout.join('')).toBe('5h: 10% · 7d: -');
    expect((deps as any)._captured.stderr.join('')).toMatch(/sesshin-statusline-relay: wrapped command exited 1/);
    expect(code).toBe(0);
  });

  it('wrap command times out: kills, falls back to default, exits 0', async () => {
    const deps = makeDeps({
      stdin: '{}',
      env: { SESSHIN_HUB_URL: 'http://x', SESSHIN_SESSION_ID: 's1', SESSHIN_USER_STATUSLINE_CMD: 'sleep 99' },
      spawn: (() => Promise.resolve({ code: null, stdout: '', stderr: '', timedOut: true })) as any,
      wrapTimeoutMs: 5,
    });
    const code = await runRelay(deps);
    expect((deps as any)._captured.stdout.join('')).toBe('');
    expect((deps as any)._captured.stderr.join('')).toMatch(/timed out/);
    expect(code).toBe(0);
  });
});
