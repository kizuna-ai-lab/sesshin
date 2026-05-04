# Session-context guard for `/sesshin-*` slash commands — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every `/sesshin-*` slash command fail fast with a clearly-classified, LLM-translatable diagnostic when the current Claude session was not launched by `sesshin claude` (or when the hub is unreachable, or when the session is orphaned), instead of producing opaque undici errors or silently feeding `--json` to the hub as a session id.

**Architecture:** A new pure helper `requireLiveSession()` in the CLI classifies the session-context state into one of `ok` / `no-env` / `hub-down` / `orphan-session` by combining env inspection with a single 1.5s probe to a new `GET /api/sessions/:id` hub route. `main.ts` runs the helper as a centralized gate before dispatching any "session-required" subcommand, prints a fixed-prefix stderr line on failure, and exits `3`. The eight slash command markdowns are updated with safer shell quoting and a uniform footnote that tells the LLM how to translate the diagnostic for the user.

**Tech Stack:** TypeScript pnpm workspace, Vitest for tests, Node `http` for the hub, native `fetch` in CLI subcommands.

**Spec:** `docs/superpowers/specs/2026-05-05-sesshin-command-guard-design.md`

---

## File Structure

| File | Change |
|---|---|
| `packages/hub/src/rest/server.ts` | modify — extend `/^\/api\/sessions\/([^/]+)$/` block to also handle `GET` (200 + minimal JSON / 404) |
| `packages/hub/src/rest/sessions.test.ts` | modify — two cases for `GET /api/sessions/:id` |
| `packages/cli/src/require-live-session.ts` | create — pure classifier helper with injected `env`, `fetch`, timeout |
| `packages/cli/src/require-live-session.test.ts` | create — six branches via fake `fetch` |
| `packages/cli/src/main.ts` | modify — export `pickFlag` and `main`; harden `pickFlag`; insert gate before `switch` |
| `packages/cli/src/main.test.ts` | create — `pickFlag` hardening + gate integration |
| `packages/cli/src/commands-bundle/sesshin-status.md` | modify — quote `"${SESSHIN_SESSION_ID:-}"`; append guard footnote |
| `packages/cli/src/commands-bundle/sesshin-clients.md` | modify — same |
| `packages/cli/src/commands-bundle/sesshin-history.md` | modify — same |
| `packages/cli/src/commands-bundle/sesshin-trust.md` | modify — same |
| `packages/cli/src/commands-bundle/sesshin-gate.md` | modify — same |
| `packages/cli/src/commands-bundle/sesshin-pin.md` | modify — same |
| `packages/cli/src/commands-bundle/sesshin-quiet.md` | modify — same |
| `packages/cli/src/commands-bundle/sesshin-log.md` | modify — same |

`packages/cli/dist/commands-bundle/*.md` is a build artifact; the `pnpm --filter @sesshin/cli build` step copies `src/commands-bundle/*.md` into `dist/`.

---

## Task ordering rationale

Bottom-up so each commit leaves the build green:

1. **Task 1:** Hub `GET /api/sessions/:id` — zero deps, exercised only by its own test until Task 4.
2. **Task 2:** `requireLiveSession` helper — pure, fully fake-`fetch` tested.
3. **Task 3:** Harden `pickFlag` (and export it + `main` from `main.ts`) — local change, has its own test.
4. **Task 4:** Wire the gate into `main.ts` `switch` and integration-test it.
5. **Task 5:** Update the eight slash command markdowns (cosmetic; markdowns are runtime-loaded by Claude Code, no build needed for tests, but `pnpm --filter @sesshin/cli build` regenerates `dist/`).
6. **Task 6:** Manual verification in both a `sesshin claude` session and a plain `claude` session.

---

## Test commands cheat-sheet

| Goal | Command |
|---|---|
| One hub test file | `pnpm --filter @sesshin/hub test src/rest/sessions.test.ts` |
| All hub tests | `pnpm --filter @sesshin/hub test` |
| One cli test file | `pnpm --filter @sesshin/cli test src/require-live-session.test.ts` |
| All cli tests | `pnpm --filter @sesshin/cli test` |
| Build cli (regenerates `dist/commands-bundle/*.md`) | `pnpm --filter @sesshin/cli build` |
| Full workspace typecheck/build | `pnpm build` |

---

### Task 1: Hub `GET /api/sessions/:id` existence probe

**Files:**
- Modify: `packages/hub/src/rest/server.ts:191-196`
- Modify: `packages/hub/src/rest/sessions.test.ts`

The existing block at `server.ts:191-196` only handles `DELETE`. Extend it to also handle `GET`. Use the same `deps.registry.get(id)` lookup that other route handlers use (heartbeat at line 188, raw at line 143, etc.).

- [ ] **Step 1: Write failing tests**

Append to `packages/hub/src/rest/sessions.test.ts` (after the existing `describe('/api/sessions', …)` block, before `describe('heartbeat', …)`):

```ts
describe('GET /api/sessions/:id', () => {
  it('returns 200 + { id } when session is registered', async () => {
    registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions/s1`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id: 's1' });
  });
  it('returns 404 when session is unknown', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions/missing`);
    expect(r.status).toBe(404);
  });
  it('still returns 405 for unsupported methods (e.g. PUT)', async () => {
    registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions/s1`, { method: 'PUT' });
    expect(r.status).toBe(405);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @sesshin/hub test src/rest/sessions.test.ts`

Expected: the new `GET /api/sessions/:id` describe block fails — the 200-case currently gets `404` (because the existing fall-through returns 404 for unmatched routes), the 404-case happens to pass (same fall-through), and the 405-case currently gets `405` so it would actually pass already. The 200-case is the one that proves the behavior is missing.

- [ ] **Step 3: Implement the GET branch**

In `packages/hub/src/rest/server.ts`, replace the block at lines 191-196 (currently only `DELETE`):

```ts
  const m = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (m) {
    const id = m[1]!;
    if (method === 'DELETE') return unregisterSession(id, res, deps);
    return void res.writeHead(405).end();
  }
```

…with:

```ts
  const m = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (m) {
    const id = m[1]!;
    if (method === 'GET') {
      if (!deps.registry.get(id)) return void res.writeHead(404).end();
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id }));
    }
    if (method === 'DELETE') return unregisterSession(id, res, deps);
    return void res.writeHead(405).end();
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @sesshin/hub test src/rest/sessions.test.ts`

Expected: all three new cases pass. Run the full hub suite as a regression check:

Run: `pnpm --filter @sesshin/hub test`

Expected: all pre-existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/rest/server.ts packages/hub/src/rest/sessions.test.ts
git commit -m "feat(hub): add GET /api/sessions/:id existence probe"
```

---

### Task 2: `requireLiveSession()` classifier helper

**Files:**
- Create: `packages/cli/src/require-live-session.ts`
- Create: `packages/cli/src/require-live-session.test.ts`

The helper is a pure function taking injected `env`, `explicitSessionId`, `fetch`, and an optional `hubProbeTimeoutMs`. It returns a discriminated union; it never throws. The classifier rule:

1. Resolve `sid = explicitSessionId ?? env.SESSHIN_SESSION_ID`. Empty string, undefined, or `--`-prefixed → `no-env`.
2. Resolve `hubUrl = env.SESSHIN_HUB_URL ?? 'http://127.0.0.1:9663'`.
3. `fetch(hubUrl/api/sessions/<sid>)` with `AbortController` set to `hubProbeTimeoutMs ?? 1500`.
4. Network reject / `AbortError` / non-(2xx|404) status → `hub-down`.
5. `404` → `orphan-session`.
6. `2xx` → `ok`.

- [ ] **Step 1: Write failing tests**

Create `packages/cli/src/require-live-session.test.ts`:

```ts
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
    // A fetch that never resolves; the helper's AbortController must abort it.
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
    expect(calledWith).toBe('http://127.0.0.1:9663/api/sessions/explicit');
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
    expect(calledWith).toBe('http://127.0.0.1:9999/api/sessions/abc');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @sesshin/cli test src/require-live-session.test.ts`

Expected: all cases fail with `Cannot find module './require-live-session.js'`.

- [ ] **Step 3: Implement the helper**

Create `packages/cli/src/require-live-session.ts`:

```ts
export type RequireSessionResult =
  | { ok: true;  sessionId: string; hubUrl: string }
  | { ok: false; reason: 'no-env' | 'hub-down' | 'orphan-session'; message: string };

export interface RequireSessionDeps {
  env: { SESSHIN_SESSION_ID?: string; SESSHIN_HUB_URL?: string };
  explicitSessionId?: string;
  fetch: typeof globalThis.fetch;
  hubProbeTimeoutMs?: number;
}

const PREFIX = 'sesshin: not in a live sesshin session — ';
const DEFAULT_HUB_URL = 'http://127.0.0.1:9663';
const DEFAULT_TIMEOUT_MS = 1500;

function isUsableSid(s: string | undefined): s is string {
  return typeof s === 'string' && s.length > 0 && !s.startsWith('--');
}

export async function requireLiveSession(deps: RequireSessionDeps): Promise<RequireSessionResult> {
  const sid = isUsableSid(deps.explicitSessionId)
    ? deps.explicitSessionId
    : (isUsableSid(deps.env.SESSHIN_SESSION_ID) ? deps.env.SESSHIN_SESSION_ID : undefined);

  if (!sid) {
    return {
      ok: false,
      reason: 'no-env',
      message: `${PREFIX}$SESSHIN_SESSION_ID is not set. To use /sesshin-* commands, launch Claude via 'sesshin claude' instead of 'claude'.`,
    };
  }

  const hubUrl = deps.env.SESSHIN_HUB_URL ?? DEFAULT_HUB_URL;
  const timeoutMs = deps.hubProbeTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let status: number;
  try {
    const r = await deps.fetch(`${hubUrl}/api/sessions/${sid}`, { signal: ac.signal });
    status = r.status;
  } catch {
    return {
      ok: false,
      reason: 'hub-down',
      message: `${PREFIX}hub at ${hubUrl} is not reachable. The sesshin hub may have crashed; restart with 'sesshin claude'.`,
    };
  } finally {
    clearTimeout(timer);
  }

  if (status === 404) {
    return {
      ok: false,
      reason: 'orphan-session',
      message: `${PREFIX}session ${sid} is not registered with the hub. The current session is orphaned; restart with 'sesshin claude'.`,
    };
  }
  if (status < 200 || status >= 300) {
    return {
      ok: false,
      reason: 'hub-down',
      message: `${PREFIX}hub at ${hubUrl} is not reachable. The sesshin hub may have crashed; restart with 'sesshin claude'.`,
    };
  }
  return { ok: true, sessionId: sid, hubUrl };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @sesshin/cli test src/require-live-session.test.ts`

Expected: all 10 cases pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/require-live-session.ts packages/cli/src/require-live-session.test.ts
git commit -m "feat(cli): add requireLiveSession classifier with no-env/hub-down/orphan-session/ok"
```

---

### Task 3: Harden `pickFlag` and export `main` for testability

**Files:**
- Modify: `packages/cli/src/main.ts:89-93`
- Create: `packages/cli/src/main.test.ts`

`pickFlag` currently returns whatever raw token follows `--session`, even if it's another flag (`--json`) or an empty string. This task hardens it and also exports `main` so a test can drive it without spawning the binary. No behavior change to dispatch yet — that's Task 4.

- [ ] **Step 1: Write failing tests**

Create `packages/cli/src/main.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { pickFlag } from './main.js';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @sesshin/cli test src/main.test.ts`

Expected: import error — `pickFlag` is not currently exported from `main.ts`. After the export is added (Step 3), the last two cases (`--`-prefixed and empty-string) will fail with the un-hardened logic.

- [ ] **Step 3: Export and harden `pickFlag`; export `main`**

In `packages/cli/src/main.ts`:

3a. Add `export` to the existing `async function main` declaration. Find:

```ts
async function main(): Promise<number | null> {
```

Replace with:

```ts
export async function main(): Promise<number | null> {
```

3b. Replace the existing `pickFlag` (currently at lines 89-93):

```ts
function pickFlag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}
```

…with:

```ts
export function pickFlag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined || v === '' || v.startsWith('--')) return undefined;
  return v;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @sesshin/cli test src/main.test.ts`

Expected: all five `pickFlag` cases pass.

Run the full cli suite as a regression check (some pre-existing subcommand handlers call `pickFlag` and we just made it stricter):

Run: `pnpm --filter @sesshin/cli test`

Expected: all pre-existing tests still pass. Note that the only callers of `pickFlag` in production are the `case 'status' / 'clients' / 'history' / 'trust' / 'gate' / 'pin' / 'quiet' / 'log'` branches in `main.ts`, all of which already treat a missing `--session` (undefined) as "fall through to env / explicit-error" — the new strictness can only convert silent garbage into the same explicit-error path.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/main.ts packages/cli/src/main.test.ts
git commit -m "refactor(cli): harden pickFlag against empty + --prefixed values; export for tests"
```

---

### Task 4: Wire the gate into `main.ts`

**Files:**
- Modify: `packages/cli/src/main.ts` (top of `switch`, after argv destructuring)
- Modify: `packages/cli/src/main.test.ts` (extend with gate integration cases)

Insert the gate **before** the `switch (cmd)` statement. The gate runs only for session-required subcommands (eight names). On `ok`, fall through to the existing `switch`. On not-ok, write the message + newline to stderr and return `3`.

The existing subcommand handlers already call `pickFlag(rest, '--session')` themselves and have their own usage-error paths. The gate adds a layer above them; nothing in the existing handlers needs to change.

- [ ] **Step 1: Write failing tests**

These tests target the injectable `mainWithDeps(deps)` signature that Step 3 will introduce. Append to `packages/cli/src/main.test.ts`:

```ts
import { mainWithDeps, type MainDeps } from './main.js';

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

  it('does NOT gate `claude` (would explode if it did — no hub running in test env)', async () => {
    // We can't actually run `claude` in a test, but we can prove the gate
    // doesn't run for it by giving it an obviously-bogus extra arg and
    // asserting that the failure mode is NOT the gate's stderr prefix.
    // We pick a subcommand path that fails fast inside dispatch: the unknown
    // subcommand `__not_a_real_subcommand__` falls through the switch's
    // `default` branch (returns 2 with `usage: …`).
    const { deps, stderr } = makeDeps({ argv: ['__not_a_real_subcommand__'], env: {} });
    const code = await mainWithDeps(deps);
    expect(code).toBe(2);
    expect(stderr.join('')).toMatch(/^usage: sesshin/);
  });

  it('does NOT gate `commands install` (no hub probe needed for install)', async () => {
    // Same approach: ensure that command paths NOT in SESSION_REQUIRED don't
    // hit the gate. We can't fully run `commands install` in a test (it
    // touches the user's filesystem), so we verify by constructing a minimal
    // probe: if the gate were to fire, stderr would start with the prefix.
    // For this case we use the explicit empty argv → default branch:
    // it must fall through to `usage:` (code 2), not the gate (code 3).
    const { deps, stderr } = makeDeps({ argv: [], env: {} });
    const code = await mainWithDeps(deps);
    expect(code).toBe(2);
    expect(stderr.join('')).not.toMatch(/^sesshin: not in a live sesshin session/);
  });

  it('passes through to dispatch when probe returns 200 (uses explicit --session, no real hub call)', async () => {
    // We don't have a real hub here, so the existing `case 'status'` will hit
    // /api/diagnostics on the default hub URL via real fetch and likely fail.
    // To keep this test isolated we only assert the gate itself didn't reject.
    // The dispatch failure (real fetch error to a non-running hub) will return
    // a non-3 code. This is fine — what we verify is "code != 3" and "no
    // gate prefix in stderr".
    const { deps, stderr } = makeDeps({
      argv: ['status', '--session', 'abc'],
      env: {},
      fetch: (async () => new Response(JSON.stringify({ id: 'abc' }), { status: 200 })) as typeof globalThis.fetch,
    });
    const code = await mainWithDeps(deps);
    expect(code).not.toBe(3);
    expect(stderr.join('')).not.toMatch(/^sesshin: not in a live sesshin session/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @sesshin/cli test src/main.test.ts`

Expected: imports fail — `mainWithDeps` and `MainDeps` don't exist yet.

- [ ] **Step 3: Refactor `main` and add the gate**

This step changes three things in `packages/cli/src/main.ts`:

3a. **Add the imports and constants** at the top of the file (just after the existing imports):

```ts
import { requireLiveSession } from './require-live-session.js';

const SESSION_REQUIRED = new Set(['status', 'clients', 'history', 'trust', 'gate', 'pin', 'quiet', 'log']);
```

3b. **Replace the existing `export async function main()` body** with a thin wrapper that calls a new injectable `mainWithDeps`. Find the current definition:

```ts
export async function main(): Promise<number | null> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    // … the entire switch block, unchanged …
    default:
      process.stderr.write(`usage: sesshin <claude|status|clients|history|commands|trust|gate|pin|quiet|log> ...\n`);
      return 2;
  }
}
```

…and split it into two exports. The new shape is:

```ts
export interface MainDeps {
  argv: string[];
  env: { SESSHIN_SESSION_ID?: string; SESSHIN_HUB_URL?: string };
  fetch: typeof globalThis.fetch;
  stderr: { write: (s: string) => boolean | void };
  stdout: { write: (s: string) => boolean | void };
}

export async function main(): Promise<number | null> {
  return mainWithDeps({
    argv: process.argv.slice(2),
    env: process.env as MainDeps['env'],
    fetch: globalThis.fetch,
    stderr: process.stderr,
    stdout: process.stdout,
  });
}

export async function mainWithDeps(deps: MainDeps): Promise<number | null> {
  const [cmd, ...rest] = deps.argv;

  // Session-context gate: applies to subcommands that require a live session.
  if (cmd && SESSION_REQUIRED.has(cmd)) {
    const explicit = pickFlag(rest, '--session');
    const result = await requireLiveSession({
      env: deps.env,
      ...(explicit !== undefined ? { explicitSessionId: explicit } : {}),
      fetch: deps.fetch,
    });
    if (!result.ok) {
      deps.stderr.write(result.message + '\n');
      return 3;
    }
  }

  switch (cmd) {
    // … the entire existing switch block goes here unchanged …
    default:
      deps.stderr.write(`usage: sesshin <claude|status|clients|history|commands|trust|gate|pin|quiet|log> ...\n`);
      return 2;
  }
}
```

3c. **Replace `process.stderr.write(...)` and `process.env[...]` references inside the switch** with `deps.stderr.write(...)` and `deps.env.SESSHIN_SESSION_ID` so the gate-bypass tests are deterministic. There are seven usage-error stderr sites (`case 'history'`, `case 'commands'`, `case 'trust'`, `case 'gate'`, `case 'pin'`, `case 'quiet'`, and the `default` branch) and five `process.env['SESSHIN_SESSION_ID']` reads (`case 'history'`, `case 'trust'`, `case 'gate'`, `case 'pin'`, `case 'quiet'` — `commands` and `default` do not read env). Example, for `case 'history'`:

```ts
    case 'history': {
      const sid = pickFlag(rest, '--session') ?? deps.env.SESSHIN_SESSION_ID;
      if (!sid) { deps.stderr.write('history: --session required (or SESSHIN_SESSION_ID env)\n'); return 2; }
      const nStr = pickFlag(rest, '-n');
      return runHistory({ sessionId: sid, ...(nStr ? { n: Number(nStr) } : {}), json: rest.includes('--json') });
    }
```

Apply the same two-substitution pattern to `trust`, `gate`, `pin`, `quiet`. For `case 'commands'` and the `default` branch, change only the `process.stderr.write` call.

3d. **Keep the bottom-of-file launcher unchanged**:

```ts
main().then((code) => { if (code !== null) process.exit(code); }).catch((e) => {
  process.stderr.write(`fatal: ${e?.stack ?? e}\n`);
  process.exit(1);
});
```

This calls the new wrapper which delegates to `mainWithDeps` with real dependencies.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @sesshin/cli test src/main.test.ts`

Expected: all `pickFlag` cases (from Task 3) and all six new gate-integration cases pass.

Run the full cli suite as a regression check:

Run: `pnpm --filter @sesshin/cli test`

Expected: all pre-existing tests still pass.

Run the full workspace build to confirm nothing else broke:

Run: `pnpm build`

Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/main.ts packages/cli/src/main.test.ts
git commit -m "feat(cli): centralized session-context gate before subcommand dispatch"
```

---

### Task 5: Update the eight slash-command markdown bundles

**Files:**
- Modify: `packages/cli/src/commands-bundle/sesshin-status.md`
- Modify: `packages/cli/src/commands-bundle/sesshin-clients.md`
- Modify: `packages/cli/src/commands-bundle/sesshin-history.md`
- Modify: `packages/cli/src/commands-bundle/sesshin-trust.md`
- Modify: `packages/cli/src/commands-bundle/sesshin-gate.md`
- Modify: `packages/cli/src/commands-bundle/sesshin-pin.md`
- Modify: `packages/cli/src/commands-bundle/sesshin-quiet.md`
- Modify: `packages/cli/src/commands-bundle/sesshin-log.md`

Two changes per file: (a) quote `$SESSHIN_SESSION_ID` as `"${SESSHIN_SESSION_ID:-}"` so an unset env yields an explicit empty argv slot (which the hardened `pickFlag` now rejects), and (b) append the uniform footnote that tells the LLM how to translate the new diagnostic.

The exact substitutions per file:

| File | bash line replacement |
|---|---|
| `sesshin-status.md` | `sesshin status --session $SESSHIN_SESSION_ID --json` → `sesshin status --session "${SESSHIN_SESSION_ID:-}" --json` |
| `sesshin-clients.md` | `sesshin clients --session $SESSHIN_SESSION_ID --json` → `sesshin clients --session "${SESSHIN_SESSION_ID:-}" --json` |
| `sesshin-history.md` | `sesshin history --session $SESSHIN_SESSION_ID -n ${ARGUMENTS:-20} --json` → `sesshin history --session "${SESSHIN_SESSION_ID:-}" -n ${ARGUMENTS:-20} --json` |
| `sesshin-trust.md` | `sesshin trust "${ARGUMENTS}" --session $SESSHIN_SESSION_ID` → `sesshin trust "${ARGUMENTS}" --session "${SESSHIN_SESSION_ID:-}"` |
| `sesshin-gate.md` | `sesshin gate "${ARGUMENTS}" --session $SESSHIN_SESSION_ID` → `sesshin gate "${ARGUMENTS}" --session "${SESSHIN_SESSION_ID:-}"` |
| `sesshin-pin.md` | `sesshin pin "${ARGUMENTS:-}" --session $SESSHIN_SESSION_ID` → `sesshin pin "${ARGUMENTS:-}" --session "${SESSHIN_SESSION_ID:-}"` |
| `sesshin-quiet.md` | `sesshin quiet "${ARGUMENTS:-off}" --session $SESSHIN_SESSION_ID` → `sesshin quiet "${ARGUMENTS:-off}" --session "${SESSHIN_SESSION_ID:-}"` |
| `sesshin-log.md` | Three lines under "Examples:" plus the lead `sesshin log --session $SESSHIN_SESSION_ID …` — replace each `$SESSHIN_SESSION_ID` with `"${SESSHIN_SESSION_ID:-}"`. |

The footnote to append at the end of every file (verbatim, including the leading `---` and the surrounding blank lines):

```
---

If this command exits with a line beginning `sesshin: not in a live sesshin session —`,
do NOT proceed. Explain to the user in their language that `/sesshin-*` commands only
work when Claude is launched via `sesshin claude` (not plain `claude`), and quote the
specific diagnostic from the error line so the user knows which sub-state applies
(env not set / hub not reachable / orphaned session).
```

There are no automated tests for the markdown bundles. Verification is manual + by running the build and inspecting the regenerated `dist/` copies.

- [ ] **Step 1: Update each markdown file**

For each of the eight `*.md` files, perform the bash-line substitution from the table above and append the footnote block. Use individual `Edit` operations per file to keep diffs reviewable.

- [ ] **Step 2: Verify the substitution and footnote landed in all eight files**

Run:

```bash
grep -L '\${SESSHIN_SESSION_ID:-}' packages/cli/src/commands-bundle/sesshin-*.md
```

Expected: empty output (every file contains the new quoting). If any file is listed, fix it.

Run:

```bash
grep -L 'not in a live sesshin session' packages/cli/src/commands-bundle/sesshin-*.md
```

Expected: empty output (every file contains the footnote). If any file is listed, fix it.

Confirm no file still references the old unquoted form:

```bash
grep -l ' \$SESSHIN_SESSION_ID' packages/cli/src/commands-bundle/sesshin-*.md
```

Expected: empty output.

- [ ] **Step 3: Rebuild the cli to refresh `dist/commands-bundle/`**

Run: `pnpm --filter @sesshin/cli build`

Expected: clean build. Spot-check one file:

```bash
diff packages/cli/src/commands-bundle/sesshin-status.md packages/cli/dist/commands-bundle/sesshin-status.md
```

Expected: no diff.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/commands-bundle/
git commit -m "feat(cli): slash commands quote SESSHIN_SESSION_ID and instruct LLM on guard diagnostic"
```

(`packages/cli/dist/commands-bundle/` is regenerated by build; do not commit `dist/` unless that is the convention in this repo — confirm with `git status` before adding.)

---

### Task 6: Manual verification

**Files:** none (interactive sanity check)

This task does not modify code. It runs the four scenarios from the spec's "Data flows" section against a real local install.

- [ ] **Step 1: Verify in a `sesshin claude` session — happy path**

```bash
pnpm install -g .   # or however the developer's local install is wired
sesshin claude
# inside the claude session:
/sesshin-status
```

Expected: status output renders normally. No `sesshin: not in a live sesshin session — ` line in stderr.

- [ ] **Step 2: Verify in a plain `claude` session — `no-env`**

In a separate terminal (no `sesshin` env), launch plain `claude` and run `/sesshin-status`.

Expected: the slash command exits with the line:

```
sesshin: not in a live sesshin session — $SESSHIN_SESSION_ID is not set. To use /sesshin-* commands, launch Claude via 'sesshin claude' instead of 'claude'.
```

…and the LLM in the chat replies with a translated explanation (in the user's language) referencing the same sub-state.

- [ ] **Step 3: Verify `hub-down`**

Force-kill the sesshin hub process while a `sesshin claude` session is live, then run `/sesshin-status` in that session.

Expected: the slash command exits with:

```
sesshin: not in a live sesshin session — hub at http://127.0.0.1:9663 is not reachable. The sesshin hub may have crashed; restart with 'sesshin claude'.
```

- [ ] **Step 4: Verify `orphan-session`**

Restart the sesshin hub (so its in-memory registry is empty) but keep the existing `sesshin claude` session running. Run `/sesshin-status` in that session.

Expected: the slash command exits with:

```
sesshin: not in a live sesshin session — session <sid> is not registered with the hub. The current session is orphaned; restart with 'sesshin claude'.
```

- [ ] **Step 5: Verify `--session <id>` override still bypasses env check (but probes hub)**

In a plain `claude` session (no env), invoke directly:

```bash
sesshin status --session abc123 --json
```

Expected: gate runs, sees explicit sid `abc123`, probes hub. If hub is up but doesn't know `abc123` → `orphan-session`. If hub is down → `hub-down`. Never `no-env`. Exit code is `3`.

- [ ] **Step 6: No commit needed**

This task records observations, not changes.

---

## Self-review notes

**Spec coverage check:**

- Spec §"Scope" item 1 (`requireLiveSession` helper) → Task 2.
- Spec §"Scope" item 2 (centralized gate, exit `3`, fixed prefix) → Task 4.
- Spec §"Scope" item 3 (new `GET /api/sessions/:id` route) → Task 1.
- Spec §"Scope" item 4 (harden `pickFlag` against `--`-prefixed) → Task 3 (also covers empty-string per spec §"File-level change map").
- Spec §"Scope" item 5 (markdown updates: quoting + footnote) → Task 5.
- Spec §"Scope" item 6 (unit tests: helper × 6 branches, gate integration, hub route) → Tasks 1, 2, 4 each include the relevant tests. Note: the helper test count is 10 in the plan vs the spec's "six branches"; the four extras (empty-string sid, env-`SESSHIN_HUB_URL` override, explicit-wins-over-env, 500 → hub-down) are inexpensive additions that lock in spec contract details.
- Spec §"Stderr message contract" exact strings → reproduced verbatim in Task 2 implementation step and asserted as substrings in tests.
- Spec §"Architectural fit" (no `allowed-tools` change) → preserved by Task 5 (footnote only adds prose; no new bash calls).

**Type / signature consistency check:**

- `requireLiveSession` signature is identical between Task 2 implementation and Task 4 caller.
- `pickFlag` signature unchanged between Task 3 hardening and Task 4 caller; only the rejection rules tightened.
- `MainDeps` interface in Task 4 carries `env`, `fetch`, `stderr`, `stdout`, `argv` — every field is consumed inside `mainWithDeps`. The real `main()` thin wrapper supplies all five.
- The hub route returns `application/json` body `{ id }`; the helper does not parse the body (only reads `r.status`) — the contract is intentionally minimal so future fields can be added without coordinating with the helper.
