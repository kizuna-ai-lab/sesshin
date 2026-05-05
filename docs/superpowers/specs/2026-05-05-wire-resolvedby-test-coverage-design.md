# wire.ts `resolvedBy` test coverage — design

Date: 2026-05-05
Issue: [#7](https://github.com/kizuna-ai-lab/sesshin/issues/7) — Strengthen wire.ts test coverage — resolvedBy attribution paths not exercised end-to-end
Related spec: `docs/superpowers/specs/2026-05-04-subscribe-replay-holding-state-design.md` (broadcast-point table and `resolvedBy` semantics)

## Background

`packages/hub/src/wire.ts` emits `session.prompt-request.resolved` from
six sites, each carrying a `resolvedBy` attribution:

| # | wire.ts line | reason | resolvedBy |
|---|---|---|---|
| 1 | 471 | `'decided'` | `'remote-adapter:${clientKind}'` |
| 2 | 200 | `'cancelled-tool-completed'` | `'hub-stale-cleanup'` |
| 3 | 253 | `'timeout'` (PreToolUse) | `null` |
| 4 | 329 | `'timeout'` (PermissionRequest) | `null` |
| 5 | 416 | `'cancelled-no-clients'` | `null` |
| 6 | 496 | `'session-ended'` | `null` |

`packages/hub/src/wire.test.ts` was added in #5 as a 27-line placeholder
that constructs an object literal in the test body and asserts fields
on it without invoking any code from `wire.ts`. The integration tests in
`connection.test.ts` cover the subscribe-replay path but do not exercise
any of the six broadcast points; `permission.test.ts` and `hooks.test.ts`
construct `createRestServer` with stubbed callbacks and never reach the
real wire-up.

If any of the six `resolvedBy` assignments silently regresses (typo, a
missed call site during a refactor) no test will fail today.

## Goal

Give the six broadcast points end-to-end test coverage so `resolvedBy`
attribution can't silently regress, with a test fixture lightweight
enough to run alongside the existing per-package vitest suite.

## Non-goals

- Changing protocol shape, schema, or `resolvedBy` semantics.
- Touching `connection.test.ts`, `permission.test.ts`, or
  `hooks.test.ts` (their concerns are orthogonal).
- Testing `startHub()` directly — the existing wire.test.ts comment
  ("heavy initialization makes deep unit testing low-value") already
  rejected that approach and we're not reversing that decision.
- Persistence of pending approvals across hub restarts (called out as
  out-of-scope in the prior spec).

## Approach

Extract the approval-adapter wiring out of `startHub()` into a
`createApprovalAdapters` factory exported from `wire.ts`. The factory
encapsulates the per-request state and returns the callback bundles
that `createRestServer` and `createWsServer` need. Tests construct
registry + approvals + a real WS server + a real REST server, call the
factory, drive each of the six trigger paths, and assert the
`session.prompt-request.resolved` frame received by a subscribed
actions-capable WS client.

`wire.test.ts`'s 27-line placeholder is replaced wholesale with the new
tests at the same path.

### Why this approach

Three options were considered:

1. **Factory extraction (chosen).** Reaches the broadcast wiring through
   a small, dedicated seam without spinning up `startHub()`'s checkpoint
   / summarizer / idle-watcher / file-tail side effects. Side benefit:
   shrinks the 558-line `wire.ts` by ~250 lines and removes module-level
   per-request state.
2. **Run `startHub()` on random ports.** Highest fidelity but requires
   config injection (currently env-driven), brings along heavy startup,
   and the module-level state leaks between tests. Already rejected by
   the existing wire.test.ts comment.
3. **Reproduce wiring inline in the test fixture.** Lightweight but
   tests duplicate code, not actual wire.ts — defeats the purpose of
   the issue.

## Factory contract

```ts
import type { RestDeps } from './rest/server.js';
import type { WsDeps, WsServerInstance } from './ws/server.js';
import type { HistoryEntry } from './rest/diagnostics.js';
import type { parsePolicy } from './agents/claude/approval-policy.js';

export interface ApprovalAdapters {
  restDeps: {
    onApprovalsCleanedUp:        NonNullable<RestDeps['onApprovalsCleanedUp']>;
    onPreToolUseApproval:        NonNullable<RestDeps['onPreToolUseApproval']>;
    onPermissionRequestApproval: NonNullable<RestDeps['onPermissionRequestApproval']>;
    historyForSession:           (sessionId: string, n: number) => HistoryEntry[];
  };
  wsDeps: {
    onLastActionsClientGone: NonNullable<WsDeps['onLastActionsClientGone']>;
    onPromptResponse:        NonNullable<WsDeps['onPromptResponse']>;
  };
  onSessionRemoved: (sessionId: string) => void;
}

export function createApprovalAdapters(opts: {
  registry:     SessionRegistry;
  approvals:    ApprovalManager;
  approvalGate: ReturnType<typeof parsePolicy>;
  getWs:        () => WsServerInstance | undefined;
}): ApprovalAdapters;
```

### State that moves into the factory closure

- `pendingHandlers: Map<string, PendingHandlerSlot>` (currently
  wire.ts:36)
- `pendingUpdatedInput: Map<string, Record<string, unknown>>`
  (wire.ts:37)
- `pendingUpdatedPermissions: Map<string, PermissionUpdate[]>`
  (wire.ts:42)
- `historyStore` (wire.ts:46–60)

### Code that moves into the factory body

- `onApprovalsCleanedUp` body (wire.ts:187–206)
- `onPreToolUseApproval` body (wire.ts:207–300)
- `onPermissionRequestApproval` body (wire.ts:301–386)
- `onLastActionsClientGone` body (wire.ts:401–424)
- `onPromptResponse` body (wire.ts:425–483)
- `session-removed` handler body (wire.ts:491–503), exposed as
  `onSessionRemoved`

### What stays in `startHub`

Process-startup wiring untouched: `Checkpoint`, `Dedup`, `EventBus`,
`PtyTap`, `wireStateMachine`, `wireJsonlModeTracker`,
`wirePtyIdleWatcher`, `tailSessionFile`, `wireHookIngest`,
`wireSummarizerTrigger`, raw-output subscription, port listening,
`parsePolicy(env.APPROVAL_GATE)`. The wiring order is unchanged:

```ts
const adapters = createApprovalAdapters({
  registry, approvals, approvalGate, getWs: () => wsRef,
});
const rest = createRestServer({ registry, approvals, ...adapters.restDeps, /* other rest deps */ });
const ws   = createWsServer({ registry, bus, tap, staticDir, approvals, onInput, ...adapters.wsDeps });
wsRef = ws;
registry.on('session-removed', adapters.onSessionRemoved);
```

The `wsRef` forward-declaration pattern (REST callbacks resolve `ws`
lazily via closure) is preserved as `getWs: () => wsRef`.

## Behavioral change to flag

`pendingHandlers`, `pendingUpdatedInput`, `pendingUpdatedPermissions`,
and `historyStore` are currently module-level and would be shared
across multiple `startHub()` calls in the same process. After the
move, each `createApprovalAdapters()` invocation gets its own state.
Production runs exactly one hub per process, so observable behavior
is unchanged. Tests gain isolation between cases. This is net positive
but worth calling out in the PR description.

## Test file: `packages/hub/src/wire.test.ts` (replace wholesale)

### Why a broadcast spy

`session.prompt-request.resolved` is filtered by the WS server on both
capability (`'actions'`) AND session subscription
(`ws/server.ts:147–148`). For broadcast point #5
(`cancelled-no-clients`), the trigger fires precisely when the last
actions-cap subscribed client leaves — by construction there's no
real client left to observe the frame. A real-WS-client-only fixture
can't test #5.

The fix: wrap `ws.broadcast` with a spy in the fixture. The spy
captures every frame `wire.ts` *intends to emit*, regardless of who
would receive it. This matches the issue author's "broadcast spy via
the existing `wsRef`" wording and is exactly the regression surface
the issue cares about: `resolvedBy` assignments in wire.ts call sites.

The actual capability/subscription filtering is the WS server's
concern and is already covered in `ws/connection.test.ts`. We do not
re-test it here.

### Fixture (`beforeEach`)

Mirrors `connection.test.ts` for the WS half, layers on a real REST
server, the factory, and a broadcast spy:

```ts
registry  = new SessionRegistry();
// 50ms timeout keeps the two timeout tests fast and predictable.
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
ws.broadcast = (msg: object, filter?) => {
  broadcasts.push(msg);
  realBroadcast(msg, filter);
};

wsRef = ws;
registry.on('session-removed', adapters.onSessionRemoved);

await rest.listen(0, '127.0.0.1');
await ws.listen(0, '127.0.0.1');
```

(If `ws.broadcast` is read-only on the type, an alternative seam is to
inject a wrapping `WsServerInstance` proxy into `getWs`. Implementation
detail — pick whichever is least invasive.)

A small `findResolvedFrame(broadcasts, requestId)` helper plus an
`expectResolvedFrame(frame, { reason, resolvedBy })` keep the six
assertions tight. `waitFor` polls `broadcasts` for the expected frame
to appear (matches `connection.test.ts:75–78`'s pattern).

Real WS clients are still used for triggers that require a client
(tests #1 and #5). Tests #2/#3/#4/#6 trigger via REST or registry
events and only need the spy.

### The six tests

Each test triggers the corresponding path and asserts the captured
frame carries the expected `reason` AND `resolvedBy`.

| # | `it(...)` | Trigger | Needs real WS client? |
|---|---|---|---|
| 1 | `decided → remote-adapter:<kind>` | `approvals.open` directly; an actions-cap subscribed client sends `prompt-response`. Asserts `resolvedBy === 'remote-adapter:debug-web'` (matches the kind sent in `client.identify`). | yes |
| 2 | `cancelled-tool-completed → hub-stale-cleanup` | `approvals.open` with `toolUseId: 'tu_x'`; POST to `/hooks` PostToolUse with matching `tool_use_id`. | no |
| 3 | `timeout (PreToolUse) → null` | Register session; POST to `/hooks` PreToolUse so `onPreToolUseApproval` calls `approvals.open` with `onExpire`. With the 50ms fixture timeout, expiry fires within ~100ms. | no |
| 4 | `timeout (PermissionRequest) → null` | Same shape as #3 but POST to `/permission/:sid`. Asserts the expiry broadcast from the PermissionRequest path specifically. | no |
| 5 | `cancelled-no-clients → null` | Open approval directly; an actions-cap subscribed client `client.close()`s. WS server's per-session actions-count hits zero, `adapters.wsDeps.onLastActionsClientGone` fires. Spy observes the frame. | yes (the one that closes) |
| 6 | `session-ended → null` | Open approval; call `registry.remove(sid)`. Registry emits `session-removed`, `adapters.onSessionRemoved` fires the broadcast. | no |

A seventh sanity test asserts the factory contract shape (`restDeps`
and `wsDeps` keys exist) — guards against accidental contract drift
during future refactors.

### Edge cases intentionally not covered

- ApprovalOutcome → PermissionRequest decision shape mapping
  (`allow` / `deny` / `ask` → `{behavior, ...}`). Already covered by
  `permission.test.ts`.
- `updatedInput` / `updatedPermissions` propagation through the
  per-request Maps. Covered indirectly by `permission.test.ts`'s
  allow-shape assertions; orthogonal to `resolvedBy`.
- `subscribe`-time replay of pending approvals. Covered by
  `connection.test.ts`.

## Acceptance criteria

- [ ] `createApprovalAdapters` is exported from `packages/hub/src/wire.ts`.
- [ ] `startHub()` uses the factory; runtime behavior is unchanged
      (manual smoke: `pnpm --filter @sesshin/hub dev` still serves a
      session, approval flow round-trips end-to-end through both
      PreToolUse and PermissionRequest).
- [ ] Module-level `pendingHandlers`, `pendingUpdatedInput`,
      `pendingUpdatedPermissions`, and `historyStore` are gone from
      `wire.ts`.
- [ ] `packages/hub/src/wire.test.ts` is replaced; the new file
      contains the six broadcast-point tests plus the contract-shape
      sanity test.
- [ ] All six tests pass and assert both `reason` AND `resolvedBy` on
      the received WS frame.
- [ ] `pnpm --filter @sesshin/hub test` passes; `pnpm -w typecheck`
      passes.

## Risks

- **Timeout test flakiness on slow CI.** Mitigated by using 50ms timeout
  with `waitFor` polling rather than fixed `setTimeout`. Existing tests
  already use 10–50ms timeouts (e.g., `connection.test.ts:286,288`)
  without flakes.
- **`onLastActionsClientGone` race.** WS server fires the callback
  inside the client-close handler. Test must `await waitFor(...)` for
  the spy to capture the resolved frame, not poll on a fixed delay.
- **Factory extraction touches a busy file.** The diff is mechanical
  (move bodies into a closure, add an opts plumbing layer) but spans
  ~250 lines. Reviewer should diff the moved bodies side-by-side to
  confirm zero behavioral drift.

## Open questions

None at design time. Anything that surfaces during implementation
should land back on this design via a follow-up commit, not a silent
behavioral change.
