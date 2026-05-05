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

### Fixture (`beforeEach`)

Mirrors `connection.test.ts` for the WS half, layers on a real REST
server and the factory:

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
wsRef = ws;
registry.on('session-removed', adapters.onSessionRemoved);

await rest.listen(0, '127.0.0.1');
await ws.listen(0, '127.0.0.1');
```

Test helpers (`connectClient`, `collectFrames`, `waitFor`) are copied
from `connection.test.ts` (no shared util module added — these
helpers are short and the duplication is contained to two files).

A small `expectResolvedFrame(frames, { requestId, reason, resolvedBy })`
helper inside the test file keeps the six assertions tight.

### The six tests

Each test connects an actions-cap subscribed WS client, opens an
approval (or drives a hook that opens one), triggers the path, and
asserts the resolved frame carries the expected `reason` AND
`resolvedBy`.

| # | `it(...)` | Trigger |
|---|---|---|
| 1 | `decided → remote-adapter:<kind>` | `approvals.open` directly; client sends `prompt-response` over WS — exercises `adapters.wsDeps.onPromptResponse`. Asserts `resolvedBy === 'remote-adapter:debug-web'` (matches the kind sent in `client.identify`). |
| 2 | `cancelled-tool-completed → hub-stale-cleanup` | `approvals.open` with `toolUseId: 'tu_x'`; POST to `/hooks` PostToolUse with matching `tool_use_id`. The REST handler invokes `adapters.restDeps.onApprovalsCleanedUp` which fires the broadcast. |
| 3 | `timeout (PreToolUse) → null` | Register session; POST to `/hooks` PreToolUse so `onPreToolUseApproval` calls `approvals.open` with `onExpire`. With the 50ms fixture timeout, expiry fires within ~100ms. |
| 4 | `timeout (PermissionRequest) → null` | Same shape as #3 but POST to `/permission/:sid`. Asserts the expiry broadcast from the PermissionRequest path specifically. |
| 5 | `cancelled-no-clients → null` | Open approval directly; the lone subscribed actions-cap client `client.close()`s. WS server's actions-counter hits zero, `adapters.wsDeps.onLastActionsClientGone` fires. Use a *second* state-only client to receive the broadcast (since the first is the one that left). |
| 6 | `session-ended → null` | Open approval; subscribe a state-cap client; call `registry.remove(sid)`. Registry emits `session-removed`, `adapters.onSessionRemoved` fires the broadcast. |

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
- **`onLastActionsClientGone` race.** Test must `await waitFor(...)` on
  the resolved frame on the *second* (state-only) client, not poll for
  a fixed delay. WS server fires the callback inside the close handler
  on the first client.
- **Factory extraction touches a busy file.** The diff is mechanical
  (move bodies into a closure, add an opts plumbing layer) but spans
  ~250 lines. Reviewer should diff the moved bodies side-by-side to
  confirm zero behavioral drift.

## Open questions

None at design time. Anything that surfaces during implementation
should land back on this design via a follow-up commit, not a silent
behavioral change.
