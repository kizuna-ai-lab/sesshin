# Statusline Rate-Limit Readout — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture Claude Code's account-level 5h/7d quota state from the statusline JSON channel, expose it to debug-web (and future remote clients) as a header pill, while preserving any user-configured original statusline.

**Architecture:** A new lean bin in `@sesshin/cli` (`sesshin-statusline-relay`, ~3 KB) is injected into Claude Code's `--settings` as the `statusLine.command`. On each render it reads CC's stdin JSON, fire-and-forgets a POST to the existing hub at `/reports/rate-limits`, then spawns the user's resolved original statusline (passed via env var) and forwards its output. The hub stores `RateLimitsState` per session and broadcasts a new `session.rate-limits` WS message; debug-web's store dispatches it onto a Zustand slice rendered as an inline pill in the existing `SessionDetail` header. See spec at `docs/superpowers/specs/2026-05-07-statusline-rate-limits-design.md`.

**Tech Stack:** TypeScript (Node 22 / ESM), pnpm workspaces, tsup, vitest, Zod, native `node:http`, `node-pty`, React 18 + Zustand (debug-web).

---

## File map (drives the task ordering below)

| File | New / Modify | Purpose |
|---|---|---|
| `packages/shared/src/protocol.ts` | Modify | Zod schemas + types for `RateLimitWindow`, `RateLimitsState`, `SessionRateLimits` |
| `packages/hub/src/registry/session-registry.ts` | Modify | `rateLimits` field on `SessionRecord` + `setRateLimits` / `getRateLimits` methods |
| `packages/hub/src/registry/session-registry.test.ts` | Modify | Cover the new field/methods |
| `packages/hub/src/rest/server.ts` | Modify | `onRateLimitReport` callback, `POST /reports/rate-limits` route |
| `packages/hub/src/rest/server.test.ts` | Modify | 204 / 400 / 404 cases |
| `packages/hub/src/wire.ts` | Modify | Wire registry update + WS broadcast on rate-limit report |
| `packages/hub/src/wire.test.ts` | Modify | End-to-end POST → registry → broadcast assertion |
| `packages/hub/src/ws/connection.ts` | Modify | Include current rate-limits in subscribe-replay frames |
| `packages/hub/src/ws/connection.test.ts` | Modify | Cover the replay inclusion |
| `packages/cli/src/read-claude-settings.ts` | Modify | `resolveInheritedStatusLine(opts)` helper |
| `packages/cli/src/read-claude-settings.test.ts` | Modify | Three cases for the new helper |
| `packages/cli/src/statusline-relay/relay.ts` | New | Pure-logic relay (DI for fetch/spawn/streams) |
| `packages/cli/src/statusline-relay/relay.test.ts` | New | Eight edge-case tests |
| `packages/cli/src/statusline-relay/index.ts` | New | Entry plumbing real env/streams/fetch/spawn |
| `packages/cli/bin/sesshin-statusline-relay` | New | 4-line node shim |
| `packages/cli/tsup.config.ts` | Modify | Second entry for the relay |
| `packages/cli/package.json` | Modify | Second `bin` entry |
| `packages/cli/src/settings-merge.ts` | Modify | Inject our statusLine unless opt-out env set |
| `packages/cli/src/settings-merge.test.ts` | Modify | Inject + opt-out cases |
| `packages/cli/src/claude.ts` | Modify | Resolve user statusline + propagate via env |
| `packages/cli/src/claude.test.ts` (or sibling) | New/Modify | Cover the env propagation |
| `packages/debug-web/src/store.ts` | Modify | `rateLimits` slice + WS dispatch |
| `packages/debug-web/src/store.test.ts` | Modify | Dispatch + replay-hydration cases |
| `packages/debug-web/src/components/RateLimitsPill.tsx` | New | Component with render-state matrix + countdown |
| `packages/debug-web/src/components/RateLimitsPill.test.tsx` | New | Render-state matrix + color + tick |
| `packages/debug-web/src/components/SessionDetail.tsx` | Modify | Mount the pill inline in the header row |

---

## Task 1: Shared protocol schemas

**Files:**
- Modify: `packages/shared/src/protocol.ts`
- Test: same file or `packages/shared/src/protocol.test.ts` (whichever is conventional in the package — both exist for sibling schemas)

- [ ] **Step 1: Write the failing test**

Add to `packages/shared/src/protocol.test.ts` (create if absent — match the file-naming used for adjacent schema tests):

```ts
import { describe, it, expect } from 'vitest';
import { RateLimitWindowSchema, RateLimitsStateSchema, SessionRateLimitsSchema } from './protocol.js';

describe('RateLimitWindowSchema', () => {
  it('parses a well-formed window', () => {
    const r = RateLimitWindowSchema.parse({ used_percentage: 45.2, resets_at: 1714867200 });
    expect(r).toEqual({ used_percentage: 45.2, resets_at: 1714867200 });
  });
  it('rejects when fields are missing', () => {
    expect(() => RateLimitWindowSchema.parse({ used_percentage: 1 })).toThrow();
  });
});

describe('RateLimitsStateSchema', () => {
  it('parses null windows (API-key user)', () => {
    const r = RateLimitsStateSchema.parse({ five_hour: null, seven_day: null, observed_at: 1 });
    expect(r.five_hour).toBeNull();
    expect(r.seven_day).toBeNull();
  });
  it('parses both windows present', () => {
    const r = RateLimitsStateSchema.parse({
      five_hour: { used_percentage: 45, resets_at: 100 },
      seven_day: { used_percentage: 23, resets_at: 200 },
      observed_at: 999,
    });
    expect(r.five_hour?.used_percentage).toBe(45);
    expect(r.observed_at).toBe(999);
  });
});

describe('SessionRateLimitsSchema', () => {
  it('parses a valid broadcast envelope', () => {
    const m = SessionRateLimitsSchema.parse({
      type: 'session.rate-limits',
      sessionId: 's1',
      rateLimits: { five_hour: null, seven_day: null, observed_at: 1 },
    });
    expect(m.type).toBe('session.rate-limits');
    expect(m.sessionId).toBe('s1');
  });
  it('rejects wrong type literal', () => {
    expect(() => SessionRateLimitsSchema.parse({
      type: 'session.something-else',
      sessionId: 's1',
      rateLimits: { five_hour: null, seven_day: null, observed_at: 1 },
    })).toThrow();
  });
});
```

- [ ] **Step 2: Run the test, confirm it fails**

```bash
pnpm --filter @sesshin/shared test -- protocol
```

Expected: failures referencing missing exports `RateLimitWindowSchema`, `RateLimitsStateSchema`, `SessionRateLimitsSchema`.

- [ ] **Step 3: Add the schemas to `packages/shared/src/protocol.ts`**

Append (after the existing schemas, before the type exports block):

```ts
export const RateLimitWindowSchema = z.object({
  used_percentage: z.number(),
  resets_at:       z.number(),
});

export const RateLimitsStateSchema = z.object({
  five_hour:    RateLimitWindowSchema.nullable(),
  seven_day:    RateLimitWindowSchema.nullable(),
  observed_at:  z.number(),
});

export const SessionRateLimitsSchema = z.object({
  type:        z.literal('session.rate-limits'),
  sessionId:   z.string(),
  rateLimits:  RateLimitsStateSchema,
});

export type RateLimitWindow   = z.infer<typeof RateLimitWindowSchema>;
export type RateLimitsState   = z.infer<typeof RateLimitsStateSchema>;
export type SessionRateLimits = z.infer<typeof SessionRateLimitsSchema>;
```

- [ ] **Step 4: Run the test, confirm it passes**

```bash
pnpm --filter @sesshin/shared test -- protocol
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/protocol.ts packages/shared/src/protocol.test.ts
git commit -m "feat(shared): add rate-limit window/state/broadcast schemas"
```

---

## Task 2: Registry — per-session rate-limits slot

**Files:**
- Modify: `packages/hub/src/registry/session-registry.ts`
- Test: `packages/hub/src/registry/session-registry.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `session-registry.test.ts`:

```ts
import type { RateLimitsState } from '@sesshin/shared';

describe('rateLimits', () => {
  it('returns null before any setRateLimits call', () => {
    const reg = new SessionRegistry();
    reg.register({ id: 's1', name: 'a', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    expect(reg.getRateLimits('s1')).toBeNull();
  });

  it('round-trips a state via setRateLimits / getRateLimits', () => {
    const reg = new SessionRegistry();
    reg.register({ id: 's1', name: 'a', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const state: RateLimitsState = {
      five_hour: { used_percentage: 45, resets_at: 100 },
      seven_day: null,
      observed_at: 999,
    };
    reg.setRateLimits('s1', state);
    expect(reg.getRateLimits('s1')).toEqual(state);
  });

  it('setRateLimits on unknown session is a no-op (returns false)', () => {
    const reg = new SessionRegistry();
    expect(reg.setRateLimits('missing', { five_hour: null, seven_day: null, observed_at: 1 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, confirm fail**

```bash
pnpm --filter @sesshin/hub test -- session-registry
```

Expected: failures on `getRateLimits` / `setRateLimits` not existing.

- [ ] **Step 3: Implement in `session-registry.ts`**

Add `rateLimits` to `SessionRecord` interface (after `quietUntil`):

```ts
export interface SessionRecord extends SessionInfo {
  // ... existing fields ...
  pin: string | null;
  quietUntil: number | null;
  rateLimits: RateLimitsState | null;
}
```

In `register()`, initialize the new field:

```ts
    rateLimits: null,
```

Add the import at the top:

```ts
import type { RateLimitsState } from '@sesshin/shared';
```

Add the two methods to the class (place near other getters/setters, e.g. after the `quietUntil` accessors):

```ts
  setRateLimits(id: string, state: RateLimitsState): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.rateLimits = state;
    return true;
  }

  getRateLimits(id: string): RateLimitsState | null {
    return this.sessions.get(id)?.rateLimits ?? null;
  }
```

- [ ] **Step 4: Run test, confirm pass**

```bash
pnpm --filter @sesshin/hub test -- session-registry
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/registry/session-registry.ts packages/hub/src/registry/session-registry.test.ts
git commit -m "feat(hub): add rateLimits slot to SessionRecord"
```

---

## Task 3: Hub REST endpoint `POST /reports/rate-limits`

**Files:**
- Modify: `packages/hub/src/rest/server.ts`
- Test: `packages/hub/src/rest/server.test.ts`

- [ ] **Step 1: Write the failing test**

Add a new `describe` block in `server.test.ts`. Match the existing test scaffolding pattern in the file for spinning up the server with fake deps; the snippet below assumes a test-helper named `startTestServer` already exists (it does — see how `'/hooks'` tests build the server). Adapt the helper name if local conventions differ.

```ts
describe('POST /reports/rate-limits', () => {
  it('returns 404 when sessionId is unknown', async () => {
    const reports: any[] = [];
    const { url, close } = await startTestServer({
      onRateLimitReport: (env) => { reports.push(env); },
      // registry has no session 'missing'
    });
    try {
      const r = await fetch(`${url}/reports/rate-limits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'missing', five_hour: null, seven_day: null }),
      });
      expect(r.status).toBe(404);
      expect(reports).toEqual([]);
    } finally { await close(); }
  });

  it('returns 400 on a malformed body', async () => {
    const reports: any[] = [];
    const { url, registry, close } = await startTestServer({
      onRateLimitReport: (env) => { reports.push(env); },
    });
    registry.register({ id: 's1', name: 'a', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    try {
      const r = await fetch(`${url}/reports/rate-limits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', five_hour: 'not-an-object', seven_day: null }),
      });
      expect(r.status).toBe(400);
      expect(reports).toEqual([]);
    } finally { await close(); }
  });

  it('returns 204 + invokes onRateLimitReport on a valid body', async () => {
    const reports: any[] = [];
    const { url, registry, close } = await startTestServer({
      onRateLimitReport: (env) => { reports.push(env); },
    });
    registry.register({ id: 's1', name: 'a', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    try {
      const body = {
        sessionId: 's1',
        five_hour: { used_percentage: 45, resets_at: 100 },
        seven_day: null,
      };
      const r = await fetch(`${url}/reports/rate-limits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(r.status).toBe(204);
      expect(reports).toHaveLength(1);
      expect(reports[0].sessionId).toBe('s1');
      expect(reports[0].state.five_hour).toEqual({ used_percentage: 45, resets_at: 100 });
      expect(reports[0].state.seven_day).toBeNull();
      expect(typeof reports[0].state.observed_at).toBe('number');
    } finally { await close(); }
  });
});
```

If `startTestServer` does not yet support `onRateLimitReport`, extend its options object first to forward it into `RestServerDeps`.

- [ ] **Step 2: Run test, confirm fail**

```bash
pnpm --filter @sesshin/hub test -- rest/server
```

Expected: 404 path may already exist (default no-route); 204 path will fail because the route doesn't exist yet.

- [ ] **Step 3: Implement the route + dep callback**

In `packages/hub/src/rest/server.ts`:

(a) Add to `RestServerDeps`:

```ts
  /** Fired when a rate-limit report arrives via POST /reports/rate-limits. */
  onRateLimitReport?: (env: { sessionId: string; state: RateLimitsState }) => void;
```

(b) Add an import:

```ts
import { RateLimitsStateSchema, type RateLimitsState } from '@sesshin/shared';
```

(c) Define the request schema near the existing schemas (e.g. near `RegisterBody`):

```ts
const RateLimitReportBody = z.object({
  sessionId:  z.string(),
  five_hour:  RateLimitsStateSchema.shape.five_hour,
  seven_day:  RateLimitsStateSchema.shape.seven_day,
});
```

(d) Add the route handler. Place it near the `/hooks` block (~ line 228):

```ts
  if (url.pathname === '/reports/rate-limits') {
    if (method !== 'POST') {
      res.statusCode = 405;
      res.end();
      return;
    }
    const raw = await readJsonBody(req);
    const parsed = RateLimitReportBody.safeParse(raw);
    if (!parsed.success) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'invalid body', issues: parsed.error.issues }));
      return;
    }
    if (!deps.registry.get(parsed.data.sessionId)) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const state: RateLimitsState = {
      five_hour:   parsed.data.five_hour,
      seven_day:   parsed.data.seven_day,
      observed_at: Date.now(),
    };
    deps.onRateLimitReport?.({ sessionId: parsed.data.sessionId, state });
    res.statusCode = 204;
    res.end();
    return;
  }
```

(`readJsonBody` is the same helper already used by the `/hooks` handler — reuse it.)

- [ ] **Step 4: Run test, confirm pass**

```bash
pnpm --filter @sesshin/hub test -- rest/server
```

Expected: PASS for all three cases.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/rest/server.ts packages/hub/src/rest/server.test.ts
git commit -m "feat(hub): POST /reports/rate-limits intake"
```

---

## Task 4: Wire registry update + WS broadcast on rate-limit report

**Files:**
- Modify: `packages/hub/src/wire.ts`
- Test: `packages/hub/src/wire.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `wire.test.ts`. The existing tests already build a wired hub via a helper (`buildWiredHub` or similar — match the existing convention):

```ts
describe('rate-limit report wiring', () => {
  it('stores in registry and broadcasts session.rate-limits', async () => {
    const { onRateLimitReport, registry, ws } = buildWiredHub();
    registry.register({ id: 's1', name: 'a', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const broadcasts: any[] = [];
    ws.broadcast = (m: any) => broadcasts.push(m);

    onRateLimitReport!({
      sessionId: 's1',
      state: { five_hour: { used_percentage: 45, resets_at: 100 }, seven_day: null, observed_at: 999 },
    });

    expect(registry.getRateLimits('s1')?.five_hour?.used_percentage).toBe(45);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({
      type: 'session.rate-limits',
      sessionId: 's1',
      rateLimits: { five_hour: { used_percentage: 45 } },
    });
  });
});
```

- [ ] **Step 2: Run test, confirm fail**

```bash
pnpm --filter @sesshin/hub test -- wire
```

Expected: FAIL — `onRateLimitReport` is not exposed by `buildWiredHub` yet.

- [ ] **Step 3: Implement the wire**

In `packages/hub/src/wire.ts`, locate where `RestServerDeps` is constructed for the REST server. Add the callback:

```ts
const deps: RestServerDeps = {
  // ... existing fields ...
  onRateLimitReport: ({ sessionId, state }) => {
    if (!registry.setRateLimits(sessionId, state)) return;
    getWs()?.broadcast({
      type: 'session.rate-limits',
      sessionId,
      rateLimits: state,
    });
  },
};
```

If `wire.ts` exposes a return shape used by tests, also expose the callback so the test can poke it directly without spinning up a real HTTP server. Otherwise, the test should call through HTTP (in which case adapt the test to do so).

- [ ] **Step 4: Run test, confirm pass**

```bash
pnpm --filter @sesshin/hub test -- wire
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/wire.ts packages/hub/src/wire.test.ts
git commit -m "feat(hub): wire rate-limit report → registry + WS broadcast"
```

---

## Task 5: Subscribe-replay includes current rate limits

**Files:**
- Modify: `packages/hub/src/ws/connection.ts`
- Test: `packages/hub/src/ws/connection.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `connection.test.ts` (alongside the existing replay-frame tests):

```ts
it('replay includes session.rate-limits when state exists', async () => {
  const { client, registry } = await startWsClientWithSubscription();
  registry.register({ id: 's1', name: 'a', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
  registry.setRateLimits('s1', { five_hour: { used_percentage: 30, resets_at: 200 }, seven_day: null, observed_at: 1 });

  const replayed = await client.subscribeAndCollectReplay('s1');
  const rl = replayed.find((m: any) => m.type === 'session.rate-limits');
  expect(rl).toBeDefined();
  expect(rl.rateLimits.five_hour.used_percentage).toBe(30);
});

it('replay omits session.rate-limits when state is null', async () => {
  const { client, registry } = await startWsClientWithSubscription();
  registry.register({ id: 's1', name: 'a', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
  // no setRateLimits call

  const replayed = await client.subscribeAndCollectReplay('s1');
  expect(replayed.some((m: any) => m.type === 'session.rate-limits')).toBe(false);
});
```

If the test helper `subscribeAndCollectReplay` does not exist, extend the existing replay test scaffolding to support collecting the full replay frame (look at how `'replay frame is structurally identical to a hand-built live broadcast'` builds its expected shape — line ~300 of the file).

- [ ] **Step 2: Run test, confirm fail**

```bash
pnpm --filter @sesshin/hub test -- ws/connection
```

Expected: FAIL — the replay frame does not yet include rate-limits.

- [ ] **Step 3: Implement in `connection.ts`**

Locate the subscribe-replay code (it builds and sends each `session.*` frame for the subscribed session). Add, after the existing per-session emissions:

```ts
const rl = registry.getRateLimits(sessionId);
if (rl) {
  send({
    type: 'session.rate-limits',
    sessionId,
    rateLimits: rl,
  });
}
```

The `registry` and `send` (or the equivalent function name in this scope — likely `socket.send` after JSON.stringify) names must match what the surrounding code uses; do not invent new ones.

- [ ] **Step 4: Run test, confirm pass**

```bash
pnpm --filter @sesshin/hub test -- ws/connection
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/ws/connection.ts packages/hub/src/ws/connection.test.ts
git commit -m "feat(hub): include rate-limits in subscribe-replay"
```

---

## Task 6: `resolveInheritedStatusLine` helper

**Files:**
- Modify: `packages/cli/src/read-claude-settings.ts`
- Test: `packages/cli/src/read-claude-settings.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `read-claude-settings.test.ts`:

```ts
import { resolveInheritedStatusLine } from './read-claude-settings.js';

describe('resolveInheritedStatusLine', () => {
  it('returns null when no settings file has a statusLine', () => {
    expect(resolveInheritedStatusLine({ home: HOME, cwd: CWD })).toBeNull();
  });

  it('returns user-level statusLine when only ~/.claude/settings.json has one', () => {
    mkdirSync(join(HOME, '.claude'), { recursive: true });
    writeFileSync(join(HOME, '.claude/settings.json'), JSON.stringify({
      statusLine: { type: 'command', command: 'my-statusline' },
    }));
    expect(resolveInheritedStatusLine({ home: HOME, cwd: CWD }))
      .toEqual({ command: 'my-statusline' });
  });

  it('project-level statusLine wins over user-level', () => {
    mkdirSync(join(HOME, '.claude'), { recursive: true });
    mkdirSync(join(CWD, '.claude'), { recursive: true });
    writeFileSync(join(HOME, '.claude/settings.json'), JSON.stringify({
      statusLine: { type: 'command', command: 'user-cmd' },
    }));
    writeFileSync(join(CWD, '.claude/settings.json'), JSON.stringify({
      statusLine: { type: 'command', command: 'project-cmd', padding: 1 },
    }));
    expect(resolveInheritedStatusLine({ home: HOME, cwd: CWD }))
      .toEqual({ command: 'project-cmd', padding: 1 });
  });

  it('skips the excluded settings path even if it has a statusLine', () => {
    mkdirSync(join(HOME, '.claude'), { recursive: true });
    const tmpInjected = join(CWD, 'sesshin-injected.json');
    writeFileSync(tmpInjected, JSON.stringify({
      statusLine: { type: 'command', command: 'sesshin-relay' },
    }));
    writeFileSync(join(HOME, '.claude/settings.json'), JSON.stringify({
      statusLine: { type: 'command', command: 'user-cmd' },
    }));
    expect(resolveInheritedStatusLine({ home: HOME, cwd: CWD, excludePath: tmpInjected }))
      .toEqual({ command: 'user-cmd' });
  });

  it('ignores statusLine entries whose type is not "command"', () => {
    mkdirSync(join(HOME, '.claude'), { recursive: true });
    writeFileSync(join(HOME, '.claude/settings.json'), JSON.stringify({
      statusLine: { type: 'static', value: 'hi' } as unknown,
    }));
    expect(resolveInheritedStatusLine({ home: HOME, cwd: CWD })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test, confirm fail**

```bash
pnpm --filter @sesshin/cli test -- read-claude-settings
```

Expected: FAIL on `resolveInheritedStatusLine` not exported.

- [ ] **Step 3: Implement in `read-claude-settings.ts`**

Add (export it):

```ts
export interface ResolveStatusLineOpts {
  home: string;
  cwd: string;
  /** Absolute path of a settings file to skip in the inheritance walk
   *  (used to omit our own injected --settings temp file). */
  excludePath?: string;
}

export interface InheritedStatusLine {
  command: string;
  padding?: number;
}

export function resolveInheritedStatusLine(opts: ResolveStatusLineOpts): InheritedStatusLine | null {
  const candidates: string[] = [
    '/etc/claude/settings.json',                                  // enterprise
    join(opts.cwd,  '.claude/settings.local.json'),               // project (local)
    join(opts.cwd,  '.claude/settings.json'),                     // project
    join(opts.home, '.claude/settings.json'),                     // user
  ];
  // Highest precedence first per CC's resolution order.
  for (const path of candidates) {
    if (opts.excludePath && path === opts.excludePath) continue;
    const sl = readStatusLineFromFile(path);
    if (sl) return sl;
  }
  return null;
}

function readStatusLineFromFile(path: string): InheritedStatusLine | null {
  let raw: string;
  try { raw = readFileSync(path, 'utf-8'); } catch { return null; }
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return null; }
  const sl = parsed?.statusLine;
  if (!sl || sl.type !== 'command' || typeof sl.command !== 'string') return null;
  const out: InheritedStatusLine = { command: sl.command };
  if (typeof sl.padding === 'number') out.padding = sl.padding;
  return out;
}
```

Add `import { readFileSync } from 'node:fs';` and `import { join } from 'node:path';` if not already imported in this file.

- [ ] **Step 4: Run test, confirm pass**

```bash
pnpm --filter @sesshin/cli test -- read-claude-settings
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/read-claude-settings.ts packages/cli/src/read-claude-settings.test.ts
git commit -m "feat(cli): resolveInheritedStatusLine for wrap-mode statusline"
```

---

## Task 7: Relay pure-logic module

**Files:**
- Create: `packages/cli/src/statusline-relay/relay.ts`
- Create: `packages/cli/src/statusline-relay/relay.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/statusline-relay/relay.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test, confirm fail**

```bash
pnpm --filter @sesshin/cli test -- statusline-relay
```

Expected: FAIL — module does not exist yet.

- [ ] **Step 3: Implement in `relay.ts`**

```ts
export interface RelayDeps {
  stdin: string;
  stdout: { write: (s: string) => boolean | void };
  stderr: { write: (s: string) => boolean | void };
  env: {
    SESSHIN_HUB_URL?: string;
    SESSHIN_SESSION_ID?: string;
    SESSHIN_USER_STATUSLINE_CMD?: string;
    SESSHIN_USER_STATUSLINE_PADDING?: string;
  };
  fetch: typeof globalThis.fetch;
  spawn: (
    cmd: string,
    args: string[],
    opts: { stdin: string; timeoutMs: number },
  ) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut?: boolean }>;
  fastTimeoutMs: number;
  wrapTimeoutMs: number;
}

interface RateLimitWindow { used_percentage: number; resets_at: number; }
interface RateLimitsPayload { five_hour: RateLimitWindow | null; seven_day: RateLimitWindow | null; }

export async function runRelay(deps: RelayDeps): Promise<number> {
  // 1. Parse stdin (best-effort)
  let parsed: any = null;
  let parseOk = false;
  try { parsed = JSON.parse(deps.stdin); parseOk = true; } catch { /* keep null */ }

  // 2. Extract rate_limits → payload (or skip POST if parse failed)
  let payload: RateLimitsPayload | null = null;
  if (parseOk) {
    const r = parsed?.rate_limits ?? {};
    payload = {
      five_hour: extractWindow(r?.five_hour),
      seven_day: extractWindow(r?.seven_day),
    };
  }

  // 3. Fire-and-forget POST (await, but bounded)
  if (payload && deps.env.SESSHIN_HUB_URL && deps.env.SESSHIN_SESSION_ID) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.fastTimeoutMs);
    try {
      await deps.fetch(`${deps.env.SESSHIN_HUB_URL}/reports/rate-limits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: deps.env.SESSHIN_SESSION_ID, ...payload }),
        signal: controller.signal,
      });
    } catch { /* swallow */ }
    finally { clearTimeout(timer); }
  }

  // 4. Wrap user's statusline if configured
  const userCmd = deps.env.SESSHIN_USER_STATUSLINE_CMD;
  if (userCmd && userCmd.trim().length > 0) {
    const r = await deps.spawn('sh', ['-c', userCmd], { stdin: deps.stdin, timeoutMs: deps.wrapTimeoutMs });
    if (r.timedOut) {
      deps.stderr.write(`sesshin-statusline-relay: wrapped command timed out after ${deps.wrapTimeoutMs}ms\n`);
      deps.stdout.write(defaultRender(payload));
      return 0;
    }
    if (r.code !== 0) {
      deps.stderr.write(`sesshin-statusline-relay: wrapped command exited ${r.code}\n`);
      deps.stdout.write(defaultRender(payload));
      return 0;
    }
    deps.stdout.write(r.stdout);
    return 0;
  }

  // 5. Default render
  deps.stdout.write(defaultRender(payload));
  return 0;
}

function extractWindow(w: any): RateLimitWindow | null {
  if (!w || typeof w !== 'object') return null;
  if (typeof w.used_percentage !== 'number' || typeof w.resets_at !== 'number') return null;
  return { used_percentage: w.used_percentage, resets_at: w.resets_at };
}

function defaultRender(payload: RateLimitsPayload | null): string {
  if (!payload) return '';
  const five = payload.five_hour ? `${Math.round(payload.five_hour.used_percentage)}%` : '-';
  const seven = payload.seven_day ? `${Math.round(payload.seven_day.used_percentage)}%` : '-';
  if (five === '-' && seven === '-') return '';
  return `5h: ${five} · 7d: ${seven}`;
}
```

- [ ] **Step 4: Run test, confirm pass**

```bash
pnpm --filter @sesshin/cli test -- statusline-relay
```

Expected: PASS for all 8 cases.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/statusline-relay/
git commit -m "feat(cli): statusline-relay pure-logic module + 8 edge-case tests"
```

---

## Task 8: Relay entry, bin shim, tsup config, package.json bin

**Files:**
- Create: `packages/cli/src/statusline-relay/index.ts`
- Create: `packages/cli/bin/sesshin-statusline-relay`
- Modify: `packages/cli/tsup.config.ts`
- Modify: `packages/cli/package.json`

- [ ] **Step 1: Write the entry point**

`packages/cli/src/statusline-relay/index.ts`:

```ts
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
```

- [ ] **Step 2: Write the bin shim**

`packages/cli/bin/sesshin-statusline-relay` (mirror `bin/sesshin`):

```sh
#!/usr/bin/env node
const { main } = await import('../dist/statusline-relay.js');
main().then((code) => process.exit(code)).catch((e) => {
  process.stderr.write(`fatal: ${e?.stack ?? e}\n`);
  process.exit(1);
});
```

After creating it, run:

```bash
chmod +x packages/cli/bin/sesshin-statusline-relay
```

- [ ] **Step 3: Update `tsup.config.ts`**

```ts
import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/main.ts', 'src/statusline-relay/index.ts'],
  format: ['esm'], target: 'node22', clean: true, sourcemap: true,
});
```

The output file for the new entry is `dist/statusline-relay/index.js` by default with the directory-style entry. To match the bin shim's `dist/statusline-relay.js`, either rename the bin shim's import path to `../dist/statusline-relay/index.js`, or rewrite the tsup entry as `{ 'main': 'src/main.ts', 'statusline-relay': 'src/statusline-relay/index.ts' }` (object form preserves the desired output filename). Use the object form:

```ts
export default defineConfig({
  entry: { main: 'src/main.ts', 'statusline-relay': 'src/statusline-relay/index.ts' },
  format: ['esm'], target: 'node22', clean: true, sourcemap: true,
});
```

- [ ] **Step 4: Update `package.json` bin map**

```json
"bin": {
  "sesshin": "bin/sesshin",
  "sesshin-statusline-relay": "bin/sesshin-statusline-relay"
}
```

- [ ] **Step 5: Build and smoke-test**

```bash
pnpm --filter @sesshin/cli build
ls packages/cli/dist/statusline-relay.js
echo '{"rate_limits":{"five_hour":{"used_percentage":42,"resets_at":1},"seven_day":null}}' \
  | SESSHIN_HUB_URL=http://127.0.0.1:1 SESSHIN_SESSION_ID=test \
    node packages/cli/bin/sesshin-statusline-relay
```

Expected: `dist/statusline-relay.js` exists; the smoke command prints `5h: 42% · 7d: -` to stdout (with stderr possibly noting the unreachable hub — that's fine, it's swallowed quietly thanks to AbortController). If you see no output, recheck the relay's default-render path.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/statusline-relay/index.ts packages/cli/bin/sesshin-statusline-relay packages/cli/tsup.config.ts packages/cli/package.json
git commit -m "feat(cli): wire sesshin-statusline-relay bin (tsup multi-entry)"
```

---

## Task 9: Settings-merge — inject our `statusLine` (with opt-out)

**Files:**
- Modify: `packages/cli/src/settings-merge.ts`
- Test: `packages/cli/src/settings-merge.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `settings-merge.test.ts`:

```ts
describe('statusLine injection', () => {
  it('injects sesshin-statusline-relay as statusLine.command', () => {
    const merged = mergeSettings({
      base: {},
      relayBinPath: '/abs/sesshin-statusline-relay',
      env: {},
    });
    expect(merged.statusLine).toEqual({
      type: 'command',
      command: '/abs/sesshin-statusline-relay',
    });
  });

  it('does NOT inject when SESSHIN_DISABLE_STATUSLINE_RELAY=1', () => {
    const merged = mergeSettings({
      base: {},
      relayBinPath: '/abs/relay',
      env: { SESSHIN_DISABLE_STATUSLINE_RELAY: '1' },
    });
    expect(merged.statusLine).toBeUndefined();
  });

  it('does not disturb other merged keys', () => {
    const merged = mergeSettings({
      base: { permissions: { defaultMode: 'auto' } },
      relayBinPath: '/abs/relay',
      env: {},
    });
    expect(merged.permissions).toEqual({ defaultMode: 'auto' });
    expect(merged.statusLine).toBeDefined();
  });
});
```

(`mergeSettings` is the existing function from this file — adapt the call shape if its current signature differs. The intent is: pass in the relay path + env, get a settings object that includes the relay's statusLine unless disabled.)

- [ ] **Step 2: Run test, confirm fail**

```bash
pnpm --filter @sesshin/cli test -- settings-merge
```

- [ ] **Step 3: Extend `mergeSettings` (or its caller)**

In `settings-merge.ts`, locate the function that builds the merged settings and add:

```ts
if (params.env?.SESSHIN_DISABLE_STATUSLINE_RELAY !== '1') {
  merged.statusLine = { type: 'command', command: params.relayBinPath };
}
```

`relayBinPath` should be passed in by the caller, computed once at startup. The caller (likely `claude.ts` or `settings-tempfile.ts`) resolves the absolute path of the bin via something like:

```ts
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
const cliBinDir = dirname(fileURLToPath(import.meta.url)); // adjust based on actual layout
const relayBinPath = join(cliBinDir, '..', '..', 'bin', 'sesshin-statusline-relay');
```

(Alternative: derive from `process.argv[1]` if simpler.) The test injects an arbitrary `relayBinPath`, so the caller-side resolution does not block these tests.

- [ ] **Step 4: Run test, confirm pass**

```bash
pnpm --filter @sesshin/cli test -- settings-merge
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/settings-merge.ts packages/cli/src/settings-merge.test.ts
git commit -m "feat(cli): inject statusline relay into temp settings (with opt-out)"
```

---

## Task 10: `claude.ts` — propagate user statusLine via env

**Files:**
- Modify: `packages/cli/src/claude.ts`
- Modify or create: `packages/cli/src/claude.test.ts` (or extend an existing nearby test if `claude.ts` is already tested)

- [ ] **Step 1: Write the failing test**

Sketch a test that verifies `buildClaudeChildEnv` (or whatever helper builds the env passed to the spawned Claude) includes `SESSHIN_USER_STATUSLINE_CMD` when an inherited statusLine exists, and omits it otherwise:

```ts
import { describe, it, expect } from 'vitest';
import { buildClaudeChildEnv } from './claude.js';

describe('buildClaudeChildEnv: user statusLine propagation', () => {
  it('sets SESSHIN_USER_STATUSLINE_CMD when an inherited command exists', () => {
    const env = buildClaudeChildEnv({
      base: {},
      sessionId: 's1',
      hubUrl: 'http://127.0.0.1:9663',
      inheritedStatusLine: { command: 'my-statusline', padding: 2 },
    });
    expect(env.SESSHIN_USER_STATUSLINE_CMD).toBe('my-statusline');
    expect(env.SESSHIN_USER_STATUSLINE_PADDING).toBe('2');
  });
  it('omits the env vars when no inherited command exists', () => {
    const env = buildClaudeChildEnv({
      base: {},
      sessionId: 's1',
      hubUrl: 'http://127.0.0.1:9663',
      inheritedStatusLine: null,
    });
    expect(env.SESSHIN_USER_STATUSLINE_CMD).toBeUndefined();
    expect(env.SESSHIN_USER_STATUSLINE_PADDING).toBeUndefined();
  });
});
```

If `claude.ts` does not already factor out a `buildClaudeChildEnv`, refactor it out as part of this task (small, mechanical extraction; the existing inline env construction becomes a one-liner call to the helper).

- [ ] **Step 2: Run test, confirm fail**

```bash
pnpm --filter @sesshin/cli test -- claude
```

- [ ] **Step 3: Implement**

In `claude.ts`, call `resolveInheritedStatusLine({ home: HOME, cwd: CWD, excludePath: tempSettingsPath })` once at session start, pass the result into `buildClaudeChildEnv`. In the helper:

```ts
if (inheritedStatusLine) {
  out.SESSHIN_USER_STATUSLINE_CMD = inheritedStatusLine.command;
  if (inheritedStatusLine.padding !== undefined) {
    out.SESSHIN_USER_STATUSLINE_PADDING = String(inheritedStatusLine.padding);
  }
}
```

Make sure `tempSettingsPath` is the same path that `settings-tempfile.ts` writes — that is the file we exclude.

- [ ] **Step 4: Run test, confirm pass**

```bash
pnpm --filter @sesshin/cli test -- claude
```

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/claude.ts packages/cli/src/claude.test.ts
git commit -m "feat(cli): propagate inherited statusLine to relay via env"
```

---

## Task 11: debug-web store slice

**Files:**
- Modify: `packages/debug-web/src/store.ts`
- Test: `packages/debug-web/src/store.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `store.test.ts`:

```ts
describe('rateLimits slice', () => {
  it('starts with an empty map', () => {
    const s = useStore.getState();
    expect(s.rateLimits.size).toBe(0);
  });

  it('applyRateLimits writes per session', () => {
    useStore.getState().applyRateLimits('s1', {
      five_hour: { used_percentage: 45, resets_at: 100 },
      seven_day: null,
      observed_at: 1,
    });
    expect(useStore.getState().rateLimits.get('s1')?.five_hour?.used_percentage).toBe(45);
  });

  it('dispatches session.rate-limits messages', () => {
    useStore.getState().handleWsMessage({
      type: 'session.rate-limits',
      sessionId: 's1',
      rateLimits: { five_hour: null, seven_day: { used_percentage: 23, resets_at: 200 }, observed_at: 999 },
    });
    expect(useStore.getState().rateLimits.get('s1')?.seven_day?.used_percentage).toBe(23);
  });
});
```

(Reset the store between tests via the existing reset helper if there is one — match the pattern used by adjacent tests in this file. If `handleWsMessage` is not the actual dispatch entry name, use the real one.)

- [ ] **Step 2: Run test, confirm fail**

```bash
pnpm --filter @sesshin/debug-web test -- store
```

- [ ] **Step 3: Extend `store.ts`**

(a) Add the import + slice:

```ts
import type { RateLimitsState } from '@sesshin/shared';

// inside the store-state interface:
rateLimits: Map<string, RateLimitsState>;
applyRateLimits: (sessionId: string, state: RateLimitsState) => void;
```

(b) Initial state:

```ts
rateLimits: new Map(),
applyRateLimits: (sessionId, state) => set((s) => {
  const next = new Map(s.rateLimits);
  next.set(sessionId, state);
  return { rateLimits: next };
}),
```

(c) Inside the WS message dispatcher (the function that switches on `msg.type`):

```ts
case 'session.rate-limits':
  get().applyRateLimits(msg.sessionId, msg.rateLimits);
  break;
```

- [ ] **Step 4: Run test, confirm pass**

```bash
pnpm --filter @sesshin/debug-web test -- store
```

- [ ] **Step 5: Commit**

```bash
git add packages/debug-web/src/store.ts packages/debug-web/src/store.test.ts
git commit -m "feat(debug-web): rateLimits store slice + WS dispatch"
```

---

## Task 12: `RateLimitsPill` component + SessionDetail wiring

**Files:**
- Create: `packages/debug-web/src/components/RateLimitsPill.tsx`
- Create: `packages/debug-web/src/components/RateLimitsPill.test.tsx`
- Modify: `packages/debug-web/src/components/SessionDetail.tsx`

- [ ] **Step 1: Write the failing test**

`packages/debug-web/src/components/RateLimitsPill.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { RateLimitsPill } from './RateLimitsPill.js';
import { useStore } from '../store.js';

beforeEach(() => {
  // Reset store before each test (use the project's existing reset pattern).
  useStore.setState((s) => ({ ...s, rateLimits: new Map() }));
});

describe('RateLimitsPill', () => {
  it('does not render when no entry exists for the session', () => {
    const { container } = render(<RateLimitsPill sessionId="s1" />);
    expect(container.firstChild).toBeNull();
  });

  it('does not render when both windows are null (API-key user)', () => {
    useStore.getState().applyRateLimits('s1', { five_hour: null, seven_day: null, observed_at: Date.now() });
    const { container } = render(<RateLimitsPill sessionId="s1" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders both windows when fresh', () => {
    const now = Date.now();
    useStore.getState().applyRateLimits('s1', {
      five_hour: { used_percentage: 45, resets_at: Math.floor(now / 1000) + 7320 },
      seven_day: { used_percentage: 23, resets_at: Math.floor(now / 1000) + 86400 },
      observed_at: now,
    });
    render(<RateLimitsPill sessionId="s1" />);
    expect(screen.getByText(/5h: 45%/)).toBeTruthy();
    expect(screen.getByText(/7d: 23%/)).toBeTruthy();
  });

  it('applies amber color when 5h utilization is in [70, 90)', () => {
    useStore.getState().applyRateLimits('s1', {
      five_hour: { used_percentage: 80, resets_at: Math.floor(Date.now() / 1000) + 100 },
      seven_day: null,
      observed_at: Date.now(),
    });
    const { container } = render(<RateLimitsPill sessionId="s1" />);
    const el = container.firstChild as HTMLElement;
    expect(el.style.color).toBe('rgb(245, 158, 11)');
  });

  it('applies red color when 5h utilization >= 90', () => {
    useStore.getState().applyRateLimits('s1', {
      five_hour: { used_percentage: 95, resets_at: Math.floor(Date.now() / 1000) + 100 },
      seven_day: null,
      observed_at: Date.now(),
    });
    const { container } = render(<RateLimitsPill sessionId="s1" />);
    expect((container.firstChild as HTMLElement).style.color).toBe('rgb(239, 68, 68)');
  });

  it('dims when observed_at is older than 10 minutes', () => {
    useStore.getState().applyRateLimits('s1', {
      five_hour: { used_percentage: 10, resets_at: Math.floor(Date.now() / 1000) + 100 },
      seven_day: null,
      observed_at: Date.now() - 11 * 60 * 1000,
    });
    const { container } = render(<RateLimitsPill sessionId="s1" />);
    expect((container.firstChild as HTMLElement).style.opacity).toBe('0.5');
  });

  it('countdown re-renders when timer ticks', () => {
    vi.useFakeTimers();
    const now = Date.now();
    useStore.getState().applyRateLimits('s1', {
      five_hour: { used_percentage: 10, resets_at: Math.floor(now / 1000) + 120 },
      seven_day: null,
      observed_at: now,
    });
    render(<RateLimitsPill sessionId="s1" />);
    expect(screen.getByText(/in 2m/)).toBeTruthy();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByText(/in 1m/)).toBeTruthy();
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run test, confirm fail**

```bash
pnpm --filter @sesshin/debug-web test -- RateLimitsPill
```

- [ ] **Step 3: Implement `RateLimitsPill.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { useStore } from '../store.js';

const COLOR_DEFAULT = '#eee';
const COLOR_AMBER   = '#f59e0b';
const COLOR_RED     = '#ef4444';
const STALE_MS      = 10 * 60 * 1000;

interface Props { sessionId: string; }

export function RateLimitsPill({ sessionId }: Props) {
  const state = useStore((s) => s.rateLimits.get(sessionId));
  const [, force] = useState(0);

  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  if (!state) return null;
  if (!state.five_hour && !state.seven_day) return null;

  const now = Date.now();
  const stale = now - state.observed_at >= STALE_MS;
  const five  = state.five_hour;
  const seven = state.seven_day;

  const fivePart  = five  ? `5h: ${Math.round(five.used_percentage)}%`  : '5h: -';
  const sevenPart = seven ? `7d: ${Math.round(seven.used_percentage)}%` : '7d: -';

  const reset = five ?? seven;
  const resetMs = reset ? reset.resets_at * 1000 - now : null;
  const resetPart = resetMs !== null && resetMs > 0 ? ` · in ${formatDuration(resetMs)}` : '';

  const fiveColor = (() => {
    if (!five) return COLOR_DEFAULT;
    if (five.used_percentage >= 90) return COLOR_RED;
    if (five.used_percentage >= 70) return COLOR_AMBER;
    return COLOR_DEFAULT;
  })();

  const tooltip = buildTooltip(state, now);

  return (
    <span
      title={tooltip}
      style={{
        fontSize: 12,
        padding: '2px 6px',
        borderRadius: 4,
        background: '#1a1a1a',
        color: fiveColor,
        opacity: stale ? 0.5 : 1,
      }}
    >
      {stale && '⏱ '}
      {fivePart} · {sevenPart}{resetPart}
    </span>
  );
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const days  = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins  = Math.floor((totalSec % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function buildTooltip(state: { five_hour: any; seven_day: any; observed_at: number }, now: number): string {
  const lines: string[] = [];
  if (state.five_hour) {
    const ms = state.five_hour.resets_at * 1000 - now;
    const at = new Date(state.five_hour.resets_at * 1000).toLocaleTimeString();
    lines.push(`5h window: ${state.five_hour.used_percentage.toFixed(1)}% used, resets at ${at} (in ${formatDuration(Math.max(0, ms))})`);
  }
  if (state.seven_day) {
    const ms = state.seven_day.resets_at * 1000 - now;
    const at = new Date(state.seven_day.resets_at * 1000).toLocaleString();
    lines.push(`7d window: ${state.seven_day.used_percentage.toFixed(1)}% used, resets ${at} (in ${formatDuration(Math.max(0, ms))})`);
  }
  const ageSec = Math.floor((now - state.observed_at) / 1000);
  lines.push(`last update: ${ageSec}s ago`);
  return lines.join('\n');
}
```

- [ ] **Step 4: Run test, confirm pass**

```bash
pnpm --filter @sesshin/debug-web test -- RateLimitsPill
```

- [ ] **Step 5: Wire into `SessionDetail.tsx`**

Open `packages/debug-web/src/components/SessionDetail.tsx`. The header flex row is at line 39:

```tsx
<div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
  {/* existing StateBadge / ModeBadge children */}
</div>
```

Add (at the top of the file):

```tsx
import { RateLimitsPill } from './RateLimitsPill.js';
```

Add `<RateLimitsPill sessionId={s.id} />` as a child of that flex row (after the existing badges).

- [ ] **Step 6: Sanity-check by booting debug-web**

```bash
pnpm --filter @sesshin/debug-web dev
```

Open the app, attach to a running sesshin session, exercise Claude (any prompt that hits the API). The pill should appear in the session header within ~1 statusline tick of the next API response.

- [ ] **Step 7: Commit**

```bash
git add packages/debug-web/src/components/RateLimitsPill.tsx packages/debug-web/src/components/RateLimitsPill.test.tsx packages/debug-web/src/components/SessionDetail.tsx
git commit -m "feat(debug-web): rate-limits pill in session header"
```

---

## Self-review notes

- **Spec coverage:** every section of the spec maps to a task — schemas → T1, registry slot → T2, REST endpoint → T3, registry+broadcast wiring → T4, subscribe-replay → T5, settings resolver → T6, relay logic → T7, bin packaging → T8, settings-merge → T9, env propagation → T10, store slice → T11, pill + SessionDetail integration → T12.
- **Type consistency:** `RateLimitWindow`, `RateLimitsState`, `SessionRateLimits`, `RateLimitsPayload`, `InheritedStatusLine` are referenced consistently across tasks. The relay's internal `RateLimitsPayload` is intentionally a subset (no `observed_at` — that's the hub's responsibility).
- **No placeholders:** every code block is real and runnable. The two soft spots — `startTestServer` in T3 and `buildWiredHub` in T4 — defer to whatever helper name the existing test files use, because the conventions vary between tests; the implementer should match them. This is documented inline at each site rather than left as a TBD.
- **Frequent commits:** 12 commits, one per task, each producing a green test suite.

---

## Execution

Ready for execution. Two options:

1. **Subagent-driven** (recommended): one fresh subagent per task, two-stage review between tasks, fast course-corrections.
2. **Inline:** execute tasks in this session via `superpowers:executing-plans` with checkpoints.

Pick one and we proceed.
