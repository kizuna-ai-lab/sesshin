import { describe, it, expect } from 'vitest';
import { pickFlag, mainWithDeps, type MainDeps } from './main.js';

describe('pickFlag', () => {
  it('returns the value for a normal flag-value pair', () => {
    expect(pickFlag(['--session', 'abc', '--json'], '--session')).toBe('abc');
  });
  it('returns undefined when the flag is missing', () => {
    expect(pickFlag(['--json'], '--session')).toBeUndefined();
  });
  it('returns undefined when the flag is the last token (no value)', () => {
    expect(pickFlag(['--session'], '--session')).toBeUndefined();
  });
  it('returns undefined when the next token starts with -- (looks like a flag, not a value)', () => {
    expect(pickFlag(['--session', '--json'], '--session')).toBeUndefined();
  });
  it('returns undefined when the next token is the empty string', () => {
    expect(pickFlag(['--session', '', '--json'], '--session')).toBeUndefined();
  });
});

function makeDeps(over: Partial<MainDeps> = {}): { deps: MainDeps; stderr: string[]; stdout: string[] } {
  const stderr: string[] = [];
  const stdout: string[] = [];
  return {
    stderr, stdout,
    deps: {
      argv: over.argv ?? [],
      env: over.env ?? {},
      fetch: over.fetch ?? ((async () => new Response(null, { status: 200 })) as typeof globalThis.fetch),
      stderr: { write: (s) => { stderr.push(s); return true; } },
      stdout: { write: (s) => { stdout.push(s); return true; } },
    },
  };
}

describe('main() session-context gate', () => {
  it('returns 3 with no-env diagnostic when running `status` with no env and no --session', async () => {
    const { deps, stderr } = makeDeps({ argv: ['status', '--json'], env: {} });
    const code = await mainWithDeps(deps);
    expect(code).toBe(3);
    expect(stderr.join('')).toMatch(/^sesshin: not in a live sesshin session — /);
    expect(stderr.join('')).toContain('$SESSHIN_SESSION_ID is not set');
  });

  it('returns 3 with hub-down diagnostic when env is set but fetch fails', async () => {
    const { deps, stderr } = makeDeps({
      argv: ['clients', '--json'],
      env: { SESSHIN_SESSION_ID: 'abc' },
      fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof globalThis.fetch,
    });
    const code = await mainWithDeps(deps);
    expect(code).toBe(3);
    expect(stderr.join('')).toContain('hub at http://127.0.0.1:9663 is not reachable');
  });

  it('returns 3 with orphan-session diagnostic on 404', async () => {
    const { deps, stderr } = makeDeps({
      argv: ['history'],
      env: { SESSHIN_SESSION_ID: 'abc' },
      fetch: (async () => new Response(null, { status: 404 })) as typeof globalThis.fetch,
    });
    const code = await mainWithDeps(deps);
    expect(code).toBe(3);
    expect(stderr.join('')).toContain('session abc is not registered with the hub');
  });

  it('does NOT gate unknown subcommands (falls through to default usage error)', async () => {
    const { deps, stderr } = makeDeps({ argv: ['__not_a_real_subcommand__'], env: {} });
    const code = await mainWithDeps(deps);
    expect(code).toBe(2);
    expect(stderr.join('')).toMatch(/^usage: sesshin/);
  });

  it('does NOT gate empty argv (falls through to default usage error)', async () => {
    const { deps, stderr } = makeDeps({ argv: [], env: {} });
    const code = await mainWithDeps(deps);
    expect(code).toBe(2);
    expect(stderr.join('')).not.toMatch(/^sesshin: not in a live sesshin session/);
  });

  it('passes through to dispatch when probe returns 200 (gate itself accepts)', async () => {
    const { deps, stderr } = makeDeps({
      argv: ['status', '--session', 'abc'],
      env: {},
      fetch: (async () => new Response(JSON.stringify({ id: 'abc' }), { status: 200 })) as typeof globalThis.fetch,
    });
    const code = await mainWithDeps(deps);
    // The dispatch will call /api/diagnostics with real fetch → likely fails;
    // we don't care what code it returns, only that it isn't the gate's 3.
    expect(code).not.toBe(3);
    expect(stderr.join('')).not.toMatch(/^sesshin: not in a live sesshin session/);
  });
});
