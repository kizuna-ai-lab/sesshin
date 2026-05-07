import { describe, it, expect } from 'vitest';
import { requireLiveSession } from './require-live-session.js';

function fetchOk(): typeof globalThis.fetch {
  return (async () => new Response(JSON.stringify({ id: 'abc' }), { status: 200 })) as typeof globalThis.fetch;
}
function fetchStatus(status: number): typeof globalThis.fetch {
  return (async () => new Response(null, { status })) as typeof globalThis.fetch;
}
function fetchThrows(err: unknown): typeof globalThis.fetch {
  return (async () => { throw err; }) as typeof globalThis.fetch;
}

describe('requireLiveSession', () => {
  it('returns no-env when env unset and no explicit sid', async () => {
    const r = await requireLiveSession({ env: {}, fetch: fetchOk() });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('no-env');
      expect(r.message).toMatch(/^sesshin: not in a live sesshin session — /);
      expect(r.message).toContain('$SESSHIN_SESSION_ID is not set');
    }
  });

  it('returns no-env when explicit sid is "--json" (looks like a flag)', async () => {
    const r = await requireLiveSession({ env: {}, explicitSessionId: '--json', fetch: fetchOk() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no-env');
  });

  it('returns no-env when explicit sid is empty string', async () => {
    const r = await requireLiveSession({ env: {}, explicitSessionId: '', fetch: fetchOk() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no-env');
  });

  it('returns hub-down when fetch throws TypeError (ECONNREFUSED)', async () => {
    const r = await requireLiveSession({
      env: { SESSHIN_SESSION_ID: 'abc' },
      fetch: fetchThrows(new TypeError('fetch failed')),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('hub-down');
      expect(r.message).toMatch(/^sesshin: not in a live sesshin session — /);
      expect(r.message).toContain('hub at http://127.0.0.1:9663 is not reachable');
    }
  });

  it('returns hub-down when probe is aborted (timeout)', async () => {
    const fakeFetch: typeof globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as typeof globalThis.fetch;
    const r = await requireLiveSession({
      env: { SESSHIN_SESSION_ID: 'abc' },
      fetch: fakeFetch,
      hubProbeTimeoutMs: 30,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('hub-down');
  });

  it('returns hub-down on non-2xx-non-404 (e.g. 500)', async () => {
    const r = await requireLiveSession({
      env: { SESSHIN_SESSION_ID: 'abc' },
      fetch: fetchStatus(500),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('hub-down');
  });

  it('returns orphan-session on 404', async () => {
    const r = await requireLiveSession({
      env: { SESSHIN_SESSION_ID: 'abc' },
      fetch: fetchStatus(404),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('orphan-session');
      expect(r.message).toContain('session abc is not registered with the hub');
    }
  });

  it('returns orphan-session on 200 when catalog reports endedAt set', async () => {
    // After T17 the GET catalog detail surfaces ended sessions with 200 + a
    // non-null endedAt. For live-session purposes those are still orphans.
    const fakeFetch: typeof globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: 'abc', endedAt: 1234, name: 'old' }), { status: 200 })
    ) as typeof globalThis.fetch;
    const r = await requireLiveSession({
      env: { SESSHIN_SESSION_ID: 'abc' },
      fetch: fakeFetch,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('orphan-session');
  });

  it('returns ok on 200', async () => {
    const r = await requireLiveSession({
      env: { SESSHIN_SESSION_ID: 'abc' },
      fetch: fetchOk(),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.sessionId).toBe('abc');
      expect(r.hubUrl).toBe('http://127.0.0.1:9663');
    }
  });

  it('explicitSessionId wins over env.SESSHIN_SESSION_ID', async () => {
    let calledWith: string | undefined;
    const fakeFetch: typeof globalThis.fetch = (async (input: RequestInfo | URL) => {
      calledWith = String(input);
      return new Response(JSON.stringify({ id: 'explicit' }), { status: 200 });
    }) as typeof globalThis.fetch;
    const r = await requireLiveSession({
      env: { SESSHIN_SESSION_ID: 'fromEnv' },
      explicitSessionId: 'explicit',
      fetch: fakeFetch,
    });
    expect(r.ok).toBe(true);
    expect(calledWith).toBe('http://127.0.0.1:9663/api/v1/sessions/explicit');
  });

  it('uses env.SESSHIN_HUB_URL when present', async () => {
    let calledWith: string | undefined;
    const fakeFetch: typeof globalThis.fetch = (async (input: RequestInfo | URL) => {
      calledWith = String(input);
      return new Response(null, { status: 200 });
    }) as typeof globalThis.fetch;
    const r = await requireLiveSession({
      env: { SESSHIN_SESSION_ID: 'abc', SESSHIN_HUB_URL: 'http://127.0.0.1:9999' },
      fetch: fakeFetch,
    });
    expect(r.ok).toBe(true);
    expect(calledWith).toBe('http://127.0.0.1:9999/api/v1/sessions/abc');
  });
});
