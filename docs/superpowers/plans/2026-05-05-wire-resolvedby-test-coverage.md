# wire.ts `resolvedBy` test coverage — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the six `prompt-request.resolved` broadcast points in `wire.ts` end-to-end test coverage so the `resolvedBy` attribution can't silently regress.

**Architecture:** Extract the approval-adapter wiring out of `startHub()` into a `createApprovalAdapters` factory exported from `wire.ts` (keeps factory in same file per design). Replace the placeholder `wire.test.ts` with seven tests: six broadcast-point tests using a `ws.broadcast` spy + one factory-contract sanity test.

**Tech Stack:** TypeScript, vitest, the `ws` package, Node http. Existing patterns from `packages/hub/src/ws/connection.test.ts`.

**Spec:** `docs/superpowers/specs/2026-05-05-wire-resolvedby-test-coverage-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `packages/hub/src/wire.ts` | Modify | Add `createApprovalAdapters` factory + `ApprovalAdapters` interface; move six callback bodies and four pieces of state into the factory closure; `startHub()` now consumes the factory's `restDeps` / `wsDeps` / `onSessionRemoved`. |
| `packages/hub/src/wire.test.ts` | Replace wholesale | Drop the 27-line placeholder; new file: vitest fixture with `ws.broadcast` spy + 6 broadcast-point tests + 1 factory-contract sanity test. |

No new files. The factory lives inside `wire.ts` per the brainstorm decision.

---

## Naming reminders for the engineer

- `RestServerDeps` (the actual exported name in `packages/hub/src/rest/server.ts:11`).
- `WsServerDeps` (the actual exported name in `packages/hub/src/ws/server.ts:12`).
- `WsServerInstance` (`ws/server.ts:49`) — the type of the WS server. Has a mutable `broadcast(msg, filter?)` method (line 53).
- `parsePolicy` from `packages/hub/src/agents/claude/approval-policy.ts` returns `'disabled' | 'auto' | 'always'`. `parsePolicy('always')` is what tests pass to force the gate on regardless of mode.
- `connectClient` / `collectFrames` / `waitFor` helpers pattern: see `packages/hub/src/ws/connection.test.ts:31–86`. Copy verbatim into `wire.test.ts` (no shared util module — duplication is contained to two files).

---

## Task 1: Extract `createApprovalAdapters` factory from wire.ts

**Files:**
- Modify: `packages/hub/src/wire.ts` (refactor only — no behavior change)

This is a pure refactor. The bodies of the six callbacks are copied verbatim; the only mechanical changes are:
- `wsRef?.broadcast(...)` → `getWs()?.broadcast(...)` (forward-decl seam preserved)
- `ws.broadcast(...)` (the one in `onPromptResponse`) → `getWs()?.broadcast(...)` (was inside `createWsServer`'s closure where `ws` was visible directly; after the move it's inside the factory and must go through `getWs`)
- Module-level `pendingHandlers`, `pendingUpdatedInput`, `pendingUpdatedPermissions`, `historyStore` → factory closure scope

Existing test suite is the regression net for this task. Tests added in Task 2+ will further validate.

- [ ] **Step 1: Read current wire.ts to confirm state**

Run: `wc -l packages/hub/src/wire.ts`
Expected: 558 lines.

- [ ] **Step 2: Add the factory at the top of wire.ts (just after imports)**

Replace the module-level state block (`wire.ts:30–60`, the `PendingHandlerSlot` interface plus the four `Map`/`historyStore` constants) and add the factory function.

**Mechanical substitution rules for the moved bodies — apply ONLY these two changes, nothing else:**

```
Rule 1 (applies to all callbacks except onPromptResponse):
    wsRef?.broadcast(   →   getWs()?.broadcast(

Rule 2 (applies inside onPromptResponse only — was wire.ts:471):
    ws.broadcast(       →   getWs()?.broadcast(
```

`ws` was a direct local in the WS-server constructor closure and is no longer in scope inside the factory. Everything else in each body — comments, control flow, error handling, type narrowing, the `try/finally` cleanup, `historyStore.push`, `approvals.decide`, `decision.kind` switch, `setCatchAllToolName`, `getHandler`, `shouldGatePreToolUse`, `registry.updateState`, `registry.markUsesPermissionRequest`, etc. — is preserved verbatim.

The factory contract:

```ts
// Insert AFTER the existing imports (wire.ts:1–28) and BEFORE startHub.
// Replaces the four module-level state declarations (wire.ts:30–60) — those
// disappear from module scope and reappear inside this closure.

import type { RestServerDeps } from './rest/server.js';
import type { WsServerDeps, WsServerInstance } from './ws/server.js';
import type { HistoryEntry } from './rest/diagnostics.js';
import type { ApprovalGatePolicy } from './agents/claude/approval-policy.js';

interface PendingHandlerSlot {
  handler:   ToolHandler;
  ctx:       HandlerCtx;
  toolInput: Record<string, unknown>;
  tool:      string;
}

export interface ApprovalAdapters {
  restDeps: {
    onApprovalsCleanedUp:        NonNullable<RestServerDeps['onApprovalsCleanedUp']>;
    onPreToolUseApproval:        NonNullable<RestServerDeps['onPreToolUseApproval']>;
    onPermissionRequestApproval: NonNullable<RestServerDeps['onPermissionRequestApproval']>;
    historyForSession:           NonNullable<RestServerDeps['historyForSession']>;
  };
  wsDeps: {
    onLastActionsClientGone: NonNullable<WsServerDeps['onLastActionsClientGone']>;
    onPromptResponse:        NonNullable<WsServerDeps['onPromptResponse']>;
  };
  onSessionRemoved: (sessionId: string) => void;
}

export function createApprovalAdapters(opts: {
  registry:     SessionRegistry;
  approvals:    ApprovalManager;
  approvalGate: ApprovalGatePolicy;
  getWs:        () => WsServerInstance | undefined;
}): ApprovalAdapters {
  const { registry, approvals, approvalGate, getWs } = opts;

  // Per-request state — moved from module scope (was wire.ts:36–42).
  const pendingHandlers          = new Map<string, PendingHandlerSlot>();
  const pendingUpdatedInput      = new Map<string, Record<string, unknown>>();
  const pendingUpdatedPermissions = new Map<string, PermissionUpdate[]>();

  // Per-session ring of resolved decisions — moved from module scope
  // (was wire.ts:46–60). Capped at 100 per session, newest-first via .get().
  const historyStore = (() => {
    const map = new Map<string, HistoryEntry[]>();
    return {
      push(sid: string, e: HistoryEntry): void {
        const arr = map.get(sid) ?? [];
        arr.push(e);
        if (arr.length > 100) arr.shift();
        map.set(sid, arr);
      },
      get(sid: string, n: number): HistoryEntry[] {
        return (map.get(sid) ?? []).slice(-n).reverse();
      },
    };
  })();

  // ---- callbacks below: bodies copied verbatim from wire.ts, with two
  //      mechanical substitutions:
  //        wsRef?.broadcast(...) → getWs()?.broadcast(...)
  //        ws.broadcast(...)     → getWs()?.broadcast(...)  (in onPromptResponse)
  //      Everything else unchanged.

  const onApprovalsCleanedUp: ApprovalAdapters['restDeps']['onApprovalsCleanedUp'] =
    (sessionId, requestIds) => {
      // [body copied from wire.ts:187–206 — comment block included verbatim]
      for (const rid of requestIds) {
        pendingHandlers.delete(rid);
        pendingUpdatedInput.delete(rid);
        pendingUpdatedPermissions.delete(rid);
        getWs()?.broadcast({
          type: 'session.prompt-request.resolved',
          sessionId, requestId: rid, reason: 'cancelled-tool-completed',
          resolvedBy: 'hub-stale-cleanup',
        });
      }
    };

  const onPreToolUseApproval: ApprovalAdapters['restDeps']['onPreToolUseApproval'] =
    async (env) => {
      // [body copied from wire.ts:207–300 — replace `wsRef?.broadcast` with `getWs()?.broadcast`]
      // ... full body here ...
    };

  const onPermissionRequestApproval: ApprovalAdapters['restDeps']['onPermissionRequestApproval'] =
    async (env) => {
      // [body copied from wire.ts:301–386 — replace `wsRef?.broadcast` with `getWs()?.broadcast`]
      // ... full body here ...
    };

  const onLastActionsClientGone: ApprovalAdapters['wsDeps']['onLastActionsClientGone'] =
    (sessionId) => {
      // [body copied from wire.ts:401–424 — replace `wsRef?.broadcast` with `getWs()?.broadcast`]
      // ... full body here ...
    };

  const onPromptResponse: ApprovalAdapters['wsDeps']['onPromptResponse'] =
    (sessionId, requestId, answers, clientKind) => {
      // [body copied from wire.ts:425–483 — replace `ws.broadcast` with `getWs()?.broadcast`]
      // ... full body here ...
    };

  const onSessionRemoved = (id: string): void => {
    // [body copied from wire.ts:491–503 — replace `wsRef?.broadcast` with `getWs()?.broadcast`]
    for (const a of approvals.pendingForSession(id)) {
      pendingHandlers.delete(a.requestId);
      pendingUpdatedInput.delete(a.requestId);
      pendingUpdatedPermissions.delete(a.requestId);
      getWs()?.broadcast({
        type: 'session.prompt-request.resolved',
        sessionId: id, requestId: a.requestId, reason: 'session-ended',
        resolvedBy: null,
      });
    }
    approvals.cancelForSession(id);
  };

  return {
    restDeps: {
      onApprovalsCleanedUp,
      onPreToolUseApproval,
      onPermissionRequestApproval,
      historyForSession: historyStore.get,
    },
    wsDeps: {
      onLastActionsClientGone,
      onPromptResponse,
    },
    onSessionRemoved,
  };
}
```

The five `// ... full body here ...` markers are placeholders for the verbatim copies. When you do the edit, copy the existing function bodies in full from the current wire.ts line ranges noted in the comment, and apply only the two mechanical substitutions described in the comment block.

- [ ] **Step 3: Update `startHub()` to use the factory**

Replace the body between wire.ts:163 (after `const approvalGate = parsePolicy(...)`) and wire.ts:503 (after the `session-removed` handler closes). The construction sequence becomes:

```ts
// Forward declaration so adapters' getWs closure can reach the WS server,
// which is constructed AFTER the REST server (matches today's wsRef pattern).
let wsRef: WsServerInstance | undefined;
const adapters = createApprovalAdapters({
  registry, approvals, approvalGate, getWs: () => wsRef,
});

// REST server
const rest = createRestServer({
  registry, tap, onHookEvent,
  onInjectFromHub: (id, data, source) => bridge.deliver(id, data, source).then((r) => r.ok),
  onAttachSink:    (id, deliver) => { bridge.setSink(id, deliver); },
  onDetachSink:    (id) => { bridge.clearSink(id); },
  approvals,
  hasSubscribedActionsClient: (sid) => wsRef?.hasSubscribedActionsClient(sid) ?? false,
  listClients: (sid) => wsRef?.listClients(sid) ?? [],
  ...adapters.restDeps,
});
await rest.listen(config.internalPort, config.internalHost);
log.info({ port: config.internalPort }, 'hub REST listening');

// WS server
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const staticDir  = join(__dirname, 'web');
const ws = createWsServer({
  registry, bus: dedupedBus, tap, staticDir, approvals,
  onInput: async (sessionId, data, source) => {
    const r = await bridge.deliver(sessionId, data, source);
    return { ok: r.ok, ...(r.reason !== undefined ? { reason: r.reason } : {}) };
  },
  ...adapters.wsDeps,
});
wsRef = ws;
await ws.listen(config.publicPort, config.publicHost);
log.info({ port: config.publicPort }, 'hub WS listening');

registry.on('session-removed', adapters.onSessionRemoved);
```

Note: `hasSubscribedActionsClient` and `listClients` REST deps remain inline because they're not part of the approval-adapter set — they read from the WS server, not the approval state.

The previous `let wsRef: WsServerInstance | null = null` (wire.ts:171) becomes `let wsRef: WsServerInstance | undefined` (matches the factory's `getWs: () => WsServerInstance | undefined` signature).

The previous `wsRef = ws;` (wire.ts:485) is unchanged in semantics.

The previous `registry.on('session-removed', (id) => { ... })` block (wire.ts:491–503) is replaced by `registry.on('session-removed', adapters.onSessionRemoved)`.

- [ ] **Step 4: Run typecheck to catch any missed substitutions**

Run: `pnpm -w typecheck`
Expected: PASS. If it fails on `wsRef` types or missing imports (`PermissionUpdate`, `HistoryEntry`, `ApprovalGatePolicy`, `RestServerDeps`, `WsServerDeps`, `WsServerInstance`), add the imports.

- [ ] **Step 5: Run hub tests to verify no regression in existing behavior**

Run: `pnpm --filter @sesshin/hub test`
Expected: ALL pass — including `permission.test.ts`, `hooks.test.ts`, `connection.test.ts`, the existing `wire.test.ts` placeholder. The placeholder will still pass because it asserts on a manually-constructed object literal.

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/wire.ts
git commit -m "$(cat <<'EOF'
refactor(hub): extract createApprovalAdapters factory from wire.ts

Pulls the approval-adapter wiring (six callbacks + per-request state)
out of startHub() into a testable factory. State that was module-level
(pendingHandlers, pendingUpdated{Input,Permissions}, historyStore) now
lives in the factory closure — production unchanged (one hub per
process), tests gain isolation. wsRef forward-decl preserved as
getWs: () => wsRef.

Refs #7.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Replace wire.test.ts placeholder with fixture + factory-contract sanity test

**Files:**
- Replace: `packages/hub/src/wire.test.ts`

The seventh ("contract-shape sanity") test goes first because it validates the fixture is wired correctly without depending on any of the broadcast triggers.

- [ ] **Step 1: Replace `wire.test.ts` with new fixture skeleton + sanity test**

Overwrite the file (do not edit incrementally — the placeholder content is being deleted entirely):

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { createApprovalAdapters } from './wire.js';
import { createRestServer, type RestServer } from './rest/server.js';
import { createWsServer, type WsServerInstance } from './ws/server.js';
import { SessionRegistry } from './registry/session-registry.js';
import { ApprovalManager } from './approval-manager.js';
import { EventBus } from './event-bus.js';
import { PtyTap } from './observers/pty-tap.js';
import { parsePolicy } from './agents/claude/approval-policy.js';
import { randomUUID } from 'node:crypto';

// Tests in this file exercise wire.ts's broadcast wiring via the
// createApprovalAdapters factory. The WS server filters
// session.prompt-request.resolved by capability AND subscription, so for
// the cancelled-no-clients path no real client survives to observe the
// broadcast. We wrap ws.broadcast with a spy that captures every frame
// wire.ts intends to emit. Capability/subscription filtering is the WS
// server's concern and is covered separately in ws/connection.test.ts.

let registry: SessionRegistry;
let approvals: ApprovalManager;
let rest: RestServer;
let ws:   WsServerInstance;
let restPort: number;
let wsPort:   number;
let broadcasts: object[];

beforeEach(async () => {
  registry  = new SessionRegistry();
  // 50ms keeps the two timeout tests fast; matches the timer scale
  // already used in connection.test.ts:286,288.
  approvals = new ApprovalManager({ defaultTimeoutMs: 50 });

  let wsRef: WsServerInstance | undefined;
  const adapters = createApprovalAdapters({
    registry, approvals,
    approvalGate: parsePolicy('always'),  // force gate ON regardless of mode
    getWs: () => wsRef,
  });

  rest = createRestServer({ registry, approvals, ...adapters.restDeps });
  ws   = createWsServer({
    registry,
    bus:        new EventBus(),
    tap:        new PtyTap({ ringBytes: 1024 }),
    staticDir:  null,
    approvals,
    onInput:    async () => ({ ok: true }),
    ...adapters.wsDeps,
  });

  // Wrap broadcast with a spy. Captures every frame wire.ts emits even
  // when no client would receive it (capability/subscription filtered).
  broadcasts = [];
  const realBroadcast = ws.broadcast.bind(ws);
  ws.broadcast = (msg: object, filter?: (caps: string[]) => boolean): void => {
    broadcasts.push(msg);
    realBroadcast(msg, filter);
  };

  wsRef = ws;
  registry.on('session-removed', adapters.onSessionRemoved);

  await rest.listen(0, '127.0.0.1');
  await ws.listen(0, '127.0.0.1');
  restPort = rest.address().port;
  wsPort   = ws.address().port;
});

afterEach(async () => {
  await rest.close();
  await ws.close();
});

// ---- helpers (lifted verbatim from connection.test.ts pattern) ----

function openSocket(): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${wsPort}/v1/ws`);
}

function recvFirst(client: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    client.once('message', (m) => resolve(JSON.parse(m.toString())));
    client.once('error', reject);
  });
}

async function connectClient(capabilities: string[]): Promise<WebSocket> {
  const client = await new Promise<WebSocket>((res, rej) => {
    const w = openSocket(); w.on('open', () => res(w)); w.on('error', rej);
  });
  client.send(JSON.stringify({
    type: 'client.identify', protocol: 1,
    client: { kind: 'debug-web', version: '0.0.0', capabilities },
  }));
  await recvFirst(client);
  return client;
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await delay(10);
  }
}

function registerSession(): string {
  const id = randomUUID();
  registry.register({
    id, name: 'n', agent: 'claude-code', cwd: '/x', pid: 1,
    sessionFilePath: '/x/session.jsonl',
  });
  return id;
}

interface ResolvedFrame {
  type: 'session.prompt-request.resolved';
  sessionId: string;
  requestId: string;
  reason:    string;
  resolvedBy: string | null;
}

function findResolvedFrame(reqId: string): ResolvedFrame | undefined {
  return broadcasts.find(
    (f): f is ResolvedFrame =>
      (f as any).type === 'session.prompt-request.resolved'
      && (f as any).requestId === reqId,
  );
}

// ---- tests ----

describe('createApprovalAdapters — factory contract shape', () => {
  it('returns restDeps, wsDeps, and onSessionRemoved with the expected keys', () => {
    let wsRef: WsServerInstance | undefined;
    const adapters = createApprovalAdapters({
      registry: new SessionRegistry(),
      approvals: new ApprovalManager({ defaultTimeoutMs: 1000 }),
      approvalGate: parsePolicy('always'),
      getWs: () => wsRef,
    });

    expect(Object.keys(adapters.restDeps).sort()).toEqual([
      'historyForSession',
      'onApprovalsCleanedUp',
      'onPermissionRequestApproval',
      'onPreToolUseApproval',
    ]);
    expect(Object.keys(adapters.wsDeps).sort()).toEqual([
      'onLastActionsClientGone',
      'onPromptResponse',
    ]);
    expect(typeof adapters.onSessionRemoved).toBe('function');
  });
});
```

- [ ] **Step 2: Run the new test file alone**

Run: `pnpm --filter @sesshin/hub exec vitest run src/wire.test.ts`
Expected: 1 passed (the contract-shape test).

`findResolvedFrame` and `ResolvedFrame` are unused at this point but will be used by Tasks 3–8. If the project's lint config flags them as unused, the next task will use them anyway — leave the helpers in.

- [ ] **Step 3: Commit**

```bash
git add packages/hub/src/wire.test.ts
git commit -m "$(cat <<'EOF'
test(hub): replace wire.test.ts placeholder with fixture + contract sanity test

Drops the 27-line shape-test placeholder; sets up real REST + WS + the
extracted createApprovalAdapters factory plus a ws.broadcast spy that
captures every prompt-request.resolved frame wire.ts emits. Adds a
contract-shape sanity test as the first concrete test on the factory.
The six broadcast-point tests follow in subsequent commits.

Refs #7.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Test #1 — `decided` → `remote-adapter:debug-web`

**Files:**
- Modify: `packages/hub/src/wire.test.ts`

Open an approval directly on `approvals`, broadcast a `session.prompt-request` so the client sees the request id (or just read it from `approvals.open`'s return), have the client send `prompt-response`, assert the spy captured the resolved frame.

- [ ] **Step 1: Add the test inside `wire.test.ts`**

Append after the contract-shape `describe` block:

```ts
describe('wire.ts approval adapters — resolvedBy attribution', () => {
  it('decided → resolvedBy = remote-adapter:<clientKind>', async () => {
    const sid = registerSession();
    const { request } = approvals.open({
      sessionId: sid, tool: 'Bash', toolInput: { command: 'ls' },
      origin: 'permission', questions: [
        { prompt: 'Allow?', multiSelect: false, allowFreeText: false,
          options: [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }] },
      ],
    });

    const client = await connectClient(['actions', 'state']);
    client.send(JSON.stringify({ type: 'subscribe', sessions: [sid], since: null }));
    // Give subscribe-time replay a beat to settle.
    await delay(50);

    client.send(JSON.stringify({
      type: 'prompt-response',
      requestId: request.requestId,
      answers: { '0': ['yes'] },
    }));

    await waitFor(() => findResolvedFrame(request.requestId) !== undefined);
    const frame = findResolvedFrame(request.requestId)!;
    expect(frame.reason).toBe('decided');
    expect(frame.resolvedBy).toBe('remote-adapter:debug-web');
    expect(frame.sessionId).toBe(sid);

    client.close();
  });
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @sesshin/hub exec vitest run src/wire.test.ts -t "decided"`
Expected: PASS.

- [ ] **Step 3: Sanity-check the test catches a regression**

Temporarily change `wire.ts`'s `onPromptResponse` site (the `'remote-adapter:${clientKind}'` line, originally at `wire.ts:474` and now inside the factory) to `resolvedBy: 'wrong'`. Re-run the test — it MUST fail. Revert the production change.

Run: `pnpm --filter @sesshin/hub exec vitest run src/wire.test.ts -t "decided"`
Expected after mutation: FAIL with `expected 'wrong' to be 'remote-adapter:debug-web'`. After revert: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/hub/src/wire.test.ts
git commit -m "$(cat <<'EOF'
test(hub): cover wire.ts decided → remote-adapter:<kind> broadcast (#7)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Test #2 — `cancelled-tool-completed` → `hub-stale-cleanup`

**Files:**
- Modify: `packages/hub/src/wire.test.ts`

Open an approval with a `toolUseId`, POST `/hooks` PostToolUse with the matching `tool_use_id`. The REST handler invokes `adapters.restDeps.onApprovalsCleanedUp`, which fires the broadcast.

- [ ] **Step 1: Add the test inside the existing `describe` block**

```ts
it('cancelled-tool-completed → resolvedBy = hub-stale-cleanup', async () => {
  const sid = registerSession();
  const { request } = approvals.open({
    sessionId: sid, tool: 'Bash', toolInput: { command: 'ls' },
    toolUseId: 'tu_stale', origin: 'permission', questions: [],
  });

  const r = await fetch(`http://127.0.0.1:${restPort}/hooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agent: 'claude-code', sessionId: sid, ts: Date.now(), event: 'PostToolUse',
      raw: {
        nativeEvent: 'PostToolUse', tool_name: 'Bash',
        tool_input: { command: 'ls' }, tool_use_id: 'tu_stale',
      },
    }),
  });
  expect(r.status).toBe(204);

  await waitFor(() => findResolvedFrame(request.requestId) !== undefined);
  const frame = findResolvedFrame(request.requestId)!;
  expect(frame.reason).toBe('cancelled-tool-completed');
  expect(frame.resolvedBy).toBe('hub-stale-cleanup');
  expect(frame.sessionId).toBe(sid);
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @sesshin/hub exec vitest run src/wire.test.ts -t "cancelled-tool-completed"`
Expected: PASS.

- [ ] **Step 3: Sanity-check the test catches a regression**

Mutate the factory's `onApprovalsCleanedUp` (was `wire.ts:200–204`) so `resolvedBy: 'hub-stale-cleanup'` becomes `resolvedBy: 'wrong'`. Test must FAIL. Revert.

- [ ] **Step 4: Commit**

```bash
git add packages/hub/src/wire.test.ts
git commit -m "$(cat <<'EOF'
test(hub): cover wire.ts cancelled-tool-completed → hub-stale-cleanup broadcast (#7)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Test #3 — `timeout` (PreToolUse path) → `null`

**Files:**
- Modify: `packages/hub/src/wire.test.ts`

POST `/hooks` PreToolUse → `adapters.restDeps.onPreToolUseApproval` calls `approvals.open` with `onExpire`. With the fixture's 50ms timeout, `onExpire` fires within ~100ms and broadcasts. The HTTP request also completes (with a `'ask'` decision), so we don't need to keep it hanging — but we must NOT await it before the broadcast fires, since the request only returns once the approval resolves.

Strategy: send the request without awaiting, then poll `broadcasts` for the resolved frame. Then await the request to clean up.

- [ ] **Step 1: Add the test**

```ts
it('timeout (PreToolUse) → resolvedBy = null', async () => {
  const sid = registerSession();

  // Don't await — the hook handler hangs until approval resolves
  // (decided / timeout / etc). We're testing the timeout path, so it
  // resolves via onExpire ~50ms later.
  const reqPromise = fetch(`http://127.0.0.1:${restPort}/hooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agent: 'claude-code', sessionId: sid, ts: Date.now(), event: 'PreToolUse',
      raw: {
        nativeEvent: 'PreToolUse', tool_name: 'Bash',
        tool_input: { command: 'ls' },
      },
    }),
  });

  // Wait for approvals.open to register a pending entry, then for the
  // timeout broadcast to fire.
  await waitFor(() => approvals.pendingForSession(sid).length === 1);
  const pending = approvals.pendingForSession(sid)[0]!;

  await waitFor(
    () => findResolvedFrame(pending.requestId) !== undefined,
    /* timeoutMs */ 500,
  );
  const frame = findResolvedFrame(pending.requestId)!;
  expect(frame.reason).toBe('timeout');
  expect(frame.resolvedBy).toBeNull();
  expect(frame.sessionId).toBe(sid);

  // Drain the hanging request — its body is the resulting decision.
  const r = await reqPromise;
  expect(r.status).toBe(200);
});
```

Note: `approvalGate: parsePolicy('always')` in the fixture forces the gate on regardless of permission mode, so the PreToolUse handler will always call `approvals.open` and not short-circuit through `shouldGatePreToolUse`.

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @sesshin/hub exec vitest run src/wire.test.ts -t "timeout \(PreToolUse\)"`
Expected: PASS within ~250ms.

- [ ] **Step 3: Sanity-check the test catches a regression**

Mutate the factory's `onPreToolUseApproval` `onExpire` callback (was `wire.ts:252–258`) so `resolvedBy: null` becomes `resolvedBy: 'wrong'`. Test must FAIL. Revert.

- [ ] **Step 4: Commit**

```bash
git add packages/hub/src/wire.test.ts
git commit -m "$(cat <<'EOF'
test(hub): cover wire.ts PreToolUse timeout → resolvedBy=null broadcast (#7)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Test #4 — `timeout` (PermissionRequest path) → `null`

**Files:**
- Modify: `packages/hub/src/wire.test.ts`

Same shape as Task 5 but POST `/permission/:sid`. This drives `adapters.restDeps.onPermissionRequestApproval`, which has its own (separate) `approvals.open(...)` call site with its own `onExpire` (was `wire.ts:328–334`).

- [ ] **Step 1: Add the test**

```ts
it('timeout (PermissionRequest) → resolvedBy = null', async () => {
  const sid = registerSession();

  const reqPromise = fetch(`http://127.0.0.1:${restPort}/permission/${sid}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: 'claude-uuid', hook_event_name: 'PermissionRequest',
      tool_name: 'Bash', tool_input: { command: 'ls' },
      tool_use_id: 'tu_pr_timeout',
    }),
  });

  await waitFor(() => approvals.pendingForSession(sid).length === 1);
  const pending = approvals.pendingForSession(sid)[0]!;

  await waitFor(
    () => findResolvedFrame(pending.requestId) !== undefined,
    /* timeoutMs */ 500,
  );
  const frame = findResolvedFrame(pending.requestId)!;
  expect(frame.reason).toBe('timeout');
  expect(frame.resolvedBy).toBeNull();
  expect(frame.sessionId).toBe(sid);

  const r = await reqPromise;
  // PermissionRequest passthrough on timeout returns 204 (Claude's TUI takes over).
  expect([200, 204]).toContain(r.status);
});
```

The `[200, 204]` allowance reflects that the timeout path resolves with `decision: 'ask'`, which `onPermissionRequestApproval` maps to `null` (passthrough → 204). If PermissionRequest semantics ever change to surface `ask` as a behavior, the test still passes.

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @sesshin/hub exec vitest run src/wire.test.ts -t "timeout \(PermissionRequest\)"`
Expected: PASS within ~250ms.

- [ ] **Step 3: Sanity-check**

Mutate the factory's `onPermissionRequestApproval` `onExpire` (was `wire.ts:328–334`) `resolvedBy: null` → `resolvedBy: 'wrong'`. Test must FAIL. Revert.

- [ ] **Step 4: Commit**

```bash
git add packages/hub/src/wire.test.ts
git commit -m "$(cat <<'EOF'
test(hub): cover wire.ts PermissionRequest timeout → resolvedBy=null broadcast (#7)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Test #5 — `cancelled-no-clients` → `null`

**Files:**
- Modify: `packages/hub/src/wire.test.ts`

Open an approval directly. Connect an actions-cap client and subscribe. Then close the client. WS server's per-session actions count for that session drops to zero, `onLastActionsClientGone` fires, the spy captures the broadcast.

- [ ] **Step 1: Add the test**

```ts
it('cancelled-no-clients → resolvedBy = null', async () => {
  const sid = registerSession();
  const { request } = approvals.open({
    sessionId: sid, tool: 'Bash', toolInput: { command: 'ls' },
    origin: 'permission', questions: [],
  });

  const client = await connectClient(['actions', 'state']);
  client.send(JSON.stringify({ type: 'subscribe', sessions: [sid], since: null }));
  // Wait until the WS server's actions-counter has registered the
  // subscription (so the close → counter-zero transition can fire).
  await waitFor(() => ws.hasSubscribedActionsClient(sid));

  // Closing the only actions-cap subscriber drops the per-session
  // actions count to zero → onLastActionsClientGone fires.
  client.close();

  await waitFor(() => findResolvedFrame(request.requestId) !== undefined);
  const frame = findResolvedFrame(request.requestId)!;
  expect(frame.reason).toBe('cancelled-no-clients');
  expect(frame.resolvedBy).toBeNull();
  expect(frame.sessionId).toBe(sid);
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @sesshin/hub exec vitest run src/wire.test.ts -t "cancelled-no-clients"`
Expected: PASS.

- [ ] **Step 3: Sanity-check**

Mutate the factory's `onLastActionsClientGone` (was `wire.ts:415–420`) `resolvedBy: null` → `resolvedBy: 'wrong'`. Test must FAIL. Revert.

- [ ] **Step 4: Commit**

```bash
git add packages/hub/src/wire.test.ts
git commit -m "$(cat <<'EOF'
test(hub): cover wire.ts cancelled-no-clients → resolvedBy=null broadcast (#7)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Test #6 — `session-ended` → `null`

**Files:**
- Modify: `packages/hub/src/wire.test.ts`

Open an approval, then call `registry.remove(sid)`. Registry emits `session-removed`, `adapters.onSessionRemoved` fires the broadcast. No real WS client needed.

- [ ] **Step 1: Add the test**

```ts
it('session-ended → resolvedBy = null', async () => {
  const sid = registerSession();
  const { request } = approvals.open({
    sessionId: sid, tool: 'Bash', toolInput: { command: 'ls' },
    origin: 'permission', questions: [],
  });

  registry.remove(sid);

  await waitFor(() => findResolvedFrame(request.requestId) !== undefined);
  const frame = findResolvedFrame(request.requestId)!;
  expect(frame.reason).toBe('session-ended');
  expect(frame.resolvedBy).toBeNull();
  expect(frame.sessionId).toBe(sid);
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @sesshin/hub exec vitest run src/wire.test.ts -t "session-ended"`
Expected: PASS.

- [ ] **Step 3: Sanity-check**

Mutate the factory's `onSessionRemoved` (was `wire.ts:496–500`) `resolvedBy: null` → `resolvedBy: 'wrong'`. Test must FAIL. Revert.

- [ ] **Step 4: Commit**

```bash
git add packages/hub/src/wire.test.ts
git commit -m "$(cat <<'EOF'
test(hub): cover wire.ts session-ended → resolvedBy=null broadcast (#7)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the entire wire.test.ts file**

Run: `pnpm --filter @sesshin/hub exec vitest run src/wire.test.ts`
Expected: 7 passed (1 contract + 6 broadcast points).

- [ ] **Step 2: Run the entire hub test suite**

Run: `pnpm --filter @sesshin/hub test`
Expected: ALL pass. No regressions in `permission.test.ts`, `hooks.test.ts`, `connection.test.ts`, or any other hub test.

- [ ] **Step 3: Run workspace-wide typecheck**

Run: `pnpm -w typecheck`
Expected: PASS.

- [ ] **Step 4: Verify wire.ts no longer has module-level approval state**

Run: `grep -nE '^const (pendingHandlers|pendingUpdatedInput|pendingUpdatedPermissions|historyStore)' packages/hub/src/wire.ts`
Expected: no output (those declarations now live inside the factory closure).

- [ ] **Step 5: Manual smoke test (optional but recommended for the refactor)**

Start a real session through `pnpm --filter @sesshin/hub dev` and confirm an approval flow round-trips end-to-end. If the test environment doesn't support a quick smoke test, skip and rely on the test suite.

- [ ] **Step 6: Final review checklist**

Confirm against the spec's acceptance criteria (`docs/superpowers/specs/2026-05-05-wire-resolvedby-test-coverage-design.md` § "Acceptance criteria"):
- [ ] `createApprovalAdapters` exported from `wire.ts`
- [ ] `startHub()` uses the factory; runtime behavior unchanged
- [ ] No module-level `pendingHandlers` / `pendingUpdatedInput` / `pendingUpdatedPermissions` / `historyStore` in `wire.ts`
- [ ] `wire.test.ts` replaced with 6 broadcast tests + 1 sanity test
- [ ] All 7 tests pass; each broadcast test asserts both `reason` AND `resolvedBy`
- [ ] Hub test suite passes; workspace typecheck passes

---

## Notes for the engineer

- **Two tests need real WS clients (#1 and #5); four don't (#2, #3, #4, #6).** Use the `connectClient` helper for the former; for the latter, just trigger via REST or `registry.remove`.
- **The fixture's 50ms approval timeout** (`new ApprovalManager({ defaultTimeoutMs: 50 })`) is what makes the two `timeout` tests fast. Don't bump it.
- **`approvalGate: parsePolicy('always')`** is the magic that ensures every PreToolUse goes through the gate regardless of mode. Without it, `shouldGatePreToolUse` would return false for some tool inputs and the test wouldn't reach `approvals.open`.
- **Subagent regression sanity (mutation step in Tasks 3–8) is mandatory.** Without confirming the test fails on a deliberate value change, the test might be a false positive (asserting on a literal that's hardcoded somewhere unexpected).
- **Don't commit the mutations.** Each "sanity check" step ends with reverting the production change before committing the test.
