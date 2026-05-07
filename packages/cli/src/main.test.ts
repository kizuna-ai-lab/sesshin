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

function makeDeps(over: Partial<MainDeps> = {}): { deps: MainDeps; stderr: string[] } {
  const stderr: string[] = [];
  return {
    stderr,
    deps: {
      argv: over.argv ?? [],
      env: over.env ?? {},
      fetch: over.fetch ?? ((async () => new Response(null, { status: 200 })) as typeof globalThis.fetch),
      stderr: { write: (s) => { stderr.push(s); return true; } },
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
    // The dispatch will call /api/v1/diagnostics with real fetch → likely fails;
    // we don't care what code it returns, only that it isn't the gate's 3.
    expect(code).not.toBe(3);
    expect(stderr.join('')).not.toMatch(/^sesshin: not in a live sesshin session/);
  });
});

/**
 * Dispatch coverage for lifecycle subcommands. Each test stubs the gate
 * (`/api/v1/sessions/:id` → 200) AND the lifecycle POST in a single fetch
 * function, so the gate accepts and dispatch reaches `runPause` etc.
 *
 * To distinguish the two calls we look at the URL: gate hits `/api/v1/sessions/<id>`
 * (no trailing path), lifecycle hits `.../lifecycle`.
 */
describe('main() dispatch — lifecycle subcommands', () => {
  function fetchStub(): {
    fetch: typeof globalThis.fetch;
    lifecycleCalls: Array<{ url: string; body: unknown }>;
  } {
    const lifecycleCalls: Array<{ url: string; body: unknown }> = [];
    const f = (async (input: unknown, init?: unknown) => {
      const url = String(input);
      if (url.endsWith('/lifecycle')) {
        const i = init as RequestInit | undefined;
        lifecycleCalls.push({ url, body: JSON.parse((i?.body as string) ?? '{}') });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      // gate probe
      return new Response(JSON.stringify({ id: 'sess' }), { status: 200 });
    }) as typeof globalThis.fetch;
    return { fetch: f, lifecycleCalls };
  }

  it('pause: posts {action:"pause"} when --session is given', async () => {
    const { fetch, lifecycleCalls } = fetchStub();
    const { deps } = makeDeps({ argv: ['pause', '--session', 'sess'], env: {}, fetch });
    const code = await mainWithDeps(deps);
    expect(code).toBe(0);
    expect(lifecycleCalls).toHaveLength(1);
    expect(lifecycleCalls[0]!.body).toEqual({ action: 'pause' });
  });

  it('resume: falls back to SESSHIN_SESSION_ID env', async () => {
    const { fetch, lifecycleCalls } = fetchStub();
    const { deps } = makeDeps({ argv: ['resume'], env: { SESSHIN_SESSION_ID: 'sess' }, fetch });
    const code = await mainWithDeps(deps);
    expect(code).toBe(0);
    expect(lifecycleCalls[0]!.body).toEqual({ action: 'resume' });
    expect(lifecycleCalls[0]!.url).toContain('/api/v1/sessions/sess/lifecycle');
  });

  it('kill: posts {action:"kill"}', async () => {
    const { fetch, lifecycleCalls } = fetchStub();
    const { deps } = makeDeps({ argv: ['kill', '--session', 'sess'], env: {}, fetch });
    const code = await mainWithDeps(deps);
    expect(code).toBe(0);
    expect(lifecycleCalls[0]!.body).toEqual({ action: 'kill' });
  });

  it('rename: joins positional args into a multi-word name and includes payload', async () => {
    const { fetch, lifecycleCalls } = fetchStub();
    const { deps } = makeDeps({
      argv: ['rename', 'my', 'fancy', 'session', '--session', 'sess'],
      env: {},
      fetch,
    });
    const code = await mainWithDeps(deps);
    expect(code).toBe(0);
    expect(lifecycleCalls[0]!.body).toEqual({ action: 'rename', payload: { name: 'my fancy session' } });
  });

  it('rename: with no name returns 2 with usage error', async () => {
    // No fetch needed because the gate runs first; supply env so the gate
    // doesn't short-circuit with its own diagnostic, then a fetch stub that
    // accepts the gate but would reject any POST (we should never reach it).
    const { fetch } = fetchStub();
    const { deps, stderr } = makeDeps({
      argv: ['rename', '--session', 'sess'],
      env: { SESSHIN_SESSION_ID: 'sess' },
      fetch,
    });
    const code = await mainWithDeps(deps);
    expect(code).toBe(2);
    expect(stderr.join('')).toMatch(/usage: sesshin rename/);
  });

  it('pause: with no --session and no env returns 3 (gate kicks in first)', async () => {
    // The session-context gate runs before dispatch, so a missing session
    // surfaces as the gate's diagnostic (exit 3), not the subcommand usage
    // error (exit 2). This documents the layered-validation contract.
    const { deps, stderr } = makeDeps({ argv: ['pause'], env: {} });
    const code = await mainWithDeps(deps);
    expect(code).toBe(3);
    expect(stderr.join('')).toMatch(/^sesshin: not in a live sesshin session/);
  });
});
