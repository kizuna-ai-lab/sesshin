# Subscribe-time replay of session holding state

**Issue:** [#5 — Hub does not push current holding state on client subscribe](https://github.com/kizuna-ai-lab/sesshin/issues/5)
**Date:** 2026-05-04
**Status:** Design — pending implementation

## Problem

When a remote client (debug-web reload, or a fresh phone IM / M5Stick connecting mid-session) issues `subscribe`, today's hub sends only:

1. `session.list` — `SessionInfo[]` snapshot.
2. Optional event-log replay — only when the client provides a non-null `since`.
3. Future deltas via event listeners.

What the hub does **not** send is the current *holding state* — anything the hub is mid-flight on at the moment of subscribe. Concretely:

- **Pending prompt-requests.** A user-visible prompt-card sitting on the agent's PreToolUse / PermissionRequest gate stays invisible to the new client until either it's resolved by another client or a fresh prompt is issued. The agent meanwhile is still HTTP-blocked on `approvals.open()`'s `decision` Promise — the request itself is alive; only the visualization is missing.
- **Sticky session config** — `pin`, `quietUntil`, `sessionGateOverride` live on `SessionRecord` but are explicitly stripped in `publicView()` (`session-registry.ts:217`). They never reach the wire. Setters do not emit any event, so even already-connected clients stay stale until the next reconnect.

The user-visible symptom is documented in the issue: refreshing debug-web (or a phone reconnecting) while a prompt-card is pending → the new UI comes back empty even though the hub is still holding the hook open.

## Scope

**In:**

1. On `subscribe`, replay current `pendingForSession()` as `session.prompt-request` frames structurally equivalent (deep-equal as parsed objects) to the original live broadcast.
2. Surface `pin` / `quietUntil` / `sessionGateOverride` in `SessionInfo` so `session.list` and `session.added` carry them.
3. New `session.config-changed` wire message so already-connected clients stay in sync as those three fields mutate at runtime.
4. New `resolvedBy` field on `session.prompt-request.resolved` so clients can distinguish "answered by another client" from "timed out" / "cancelled by hub".
5. Add the missing `'cancelled-tool-completed'` value to `reason` enum (pre-existing schema/code drift; `wire.ts:202` already emits it).

**Out (deferred to follow-up issues):**

- Sticky-config persistence across hub restart (the in-memory `pin`/`quiet`/`gate` is lost on hub crash). Tracked in a separate issue.
- Hook-handler protocol redesign (poll + retry instead of long-hold HTTP) for hub-crash recovery of in-flight approvals. v2 roadmap item.
- Persisting `lastEventId` in debug-web `sessionStorage` so reload also benefits from `since` event-log replay. Independent.

## Architectural fit

This sits inside the WS subscribe handshake (`packages/hub/src/ws/connection.ts:158`) and the broadcast layer (`packages/hub/src/wire.ts`). No protocol-major changes — every wire-shape addition is additive and backwards compatible (optional fields, new message type).

The hook handler is **not** modified. The HTTP long-hold protocol stays as-is. New clients receive a re-broadcast of state the hub already has; the originating hook handler's HTTP request continues to block on `approvals.decide()` exactly as before.

`actions` and `state` capability gating is preserved (today both no-op since debug-web declares all caps; non-trivial when M5Stick / Telegram adapters land).

## File-level change map

| Package / file | Change |
|---|---|
| `shared/src/session.ts` | `SessionInfoSchema` += `pin?`, `quietUntil?`, `sessionGateOverride?` (all `nullable().optional()`) |
| `shared/src/protocol.ts` | `SessionPromptRequestResolvedSchema` += `resolvedBy?: string \| null`; reason enum += `'cancelled-tool-completed'`; new `SessionConfigChangedSchema`; added to `DownstreamMessageSchema` union |
| `hub/src/approval-manager.ts` | `Entry` + `PendingApproval` += `origin`, `body?`, `questions`; `open()` requires `origin` and `questions`; `pendingForSession()` returns the new fields |
| `hub/src/registry/session-registry.ts` | `publicView()` no longer strips `pin`/`quietUntil`/`sessionGateOverride`; three setters emit `'config-changed'` (with no-op short-circuit when value unchanged); `RegistryEvents` += `'config-changed'` |
| `hub/src/ws/server.ts` | `capabilityRequiredFor` += `'session.config-changed' → 'state'`; `onPromptResponse` signature += `clientKind: string` |
| `hub/src/ws/connection.ts` | `subscribe` branch: after `session.list`, replay `pendingForSession(sid)` for each newly-added `sid` if client has `actions` cap; `attachSubscribed` += `onConfigChanged` listener; pass `state.kind ?? 'unknown'` to `onPromptResponse` |
| `hub/src/wire.ts` | `approvals.open()` calls pass `origin/body/questions` from `handler.render()`; six `prompt-request.resolved` broadcasts get a `resolvedBy` field per the table below |
| `debug-web/src/ws-client.ts` | New handler for `session.config-changed`; existing `session.prompt-request` handler unchanged (already idempotent on `requestId`) |
| `debug-web/src/store.ts` | New mutator for sticky config (merge into `sessionInfoBySession`); `removeSession(id)` also clears `promptRequestsBySession[id]` |

## Data flows

### Flow A — Fresh client joining mid-session (the core fix)

```
M5Stick / phone IM / refreshed web
  │
  │ 1. WS connect → client.identify { capabilities: [..., 'actions', 'state'] }
  │
  ▼
hub: connection.ts (identify path)
  │ identified, registerTarget(), send server.hello, attachSubscribed()
  │
  │ 2. client → subscribe { sessions: 'all' or [sid1, sid2] }
  │
  ▼
hub: connection.ts subscribe branch
  │ ① diff prev/next (existing bumpActions logic)
  │ ② added = next \ prev
  │ ③ if state cap: send session.list (now carries pin/quiet/gate)
  │ ④ NEW: if actions cap:
  │     for sid in added:
  │       for entry in approvals.pendingForSession(sid):
  │         ws.send({
  │           type: 'session.prompt-request',
  │           sessionId, requestId, origin, toolName,
  │           toolUseId?, expiresAt, body?, questions
  │         })
  │ ⑤ if events cap and msg.since: existing event-log replay
  │
  ▼
client: handles session.prompt-request via the same code path used for live
        broadcasts; cannot tell replay from live; idempotent on requestId.
```

**Critical invariant:** the originating hook handler's HTTP POST is still hanging in `approvals.open()`'s `decision` Promise. The new client answers with `prompt-response { requestId }` → `onPromptResponse` → `decide(requestId, outcome)` → resolves the Promise → wire.ts writes the decision back into the hook HTTP response → hook handler outputs to claude. The replay frame just gives the new client a visualization handle on a request the hub was already holding.

### Flow B — Sticky-config update on a running session

```
sesshin pin "deploying"  /  sesshin gate disabled  /  sesshin quiet 5m
  │
  ▼
internal REST: PATCH /api/sessions/:id/{pin,gate,quiet}
  │
  ▼
hub: registry.setPin(id, msg)
  │ if (s.pin === msg) return true     (NEW: no-op short-circuit)
  │ s.pin = msg
  │ this.emit('config-changed', this.publicView(s))    (NEW)
  │
  ▼ EventEmitter fan-out
hub: connection.ts attachSubscribed → onConfigChanged
  │ if (!isSubscribed(state, s.id) || !state.capabilities.has('state')) return
  │ ws.send({ type: 'session.config-changed', sessionId: s.id,
  │           pin: s.pin, quietUntil: s.quietUntil,
  │           sessionGateOverride: s.sessionGateOverride })
  │
  ▼
all subscribed `state`-capable clients receive a full snapshot of all three
fields (not a delta — keeps client merge logic trivial).
```

**Why a full-snapshot frame, not deltas:** each setter mutates one field, but emitting deltas forces clients to maintain merge logic. The frame is < 100 bytes — pay that cost once instead of N times in client implementations.

### Flow C — Prompt resolved with attribution

`onPromptResponse` adds a `clientKind` parameter, threaded from `connection.ts:222-225` (passes `state.kind ?? 'unknown'`). The six broadcast points carry `resolvedBy` as follows:

| `wire.ts` line | Triggered by | `reason` | `resolvedBy` |
|---|---|---|---|
| 201 | stale-cleanup (`onApprovalsCleanedUp`, called from REST when PostToolUse / Stop arrives for an unresolved approval) | `'cancelled-tool-completed'` | `'hub-stale-cleanup'` |
| 253 | PreToolUse `onExpire` (timeout) | `'timeout'` | `null` |
| 325 | PermissionRequest `onExpire` (timeout) | `'timeout'` | `null` |
| 408 | `onLastActionsClientGone` | `'cancelled-no-clients'` | `null` |
| 462 | `onPromptResponse` (remote client decided) | `'decided'` | `'remote-adapter:' + clientKind` |
| 486 | `session-removed` handler | `'session-ended'` | `null` |

`resolvedBy` is `.optional()` in the schema — old clients ignore the unknown field, new clients can render "approved by phone" UX vs "timed out" UX.

## Schema additions (precise)

### `shared/src/session.ts`

```ts
export const SessionInfoSchema = z.object({
  // ... existing fields ...
  sessionFilePath:     z.string().optional(),
  // NEW (all triple-state: missing | null | value):
  pin:                 z.string().nullable().optional(),
  quietUntil:          z.number().int().nullable().optional(),
  sessionGateOverride: z.enum(['disabled','auto','always']).nullable().optional(),
});
```

### `shared/src/protocol.ts`

```ts
export const SessionPromptRequestResolvedSchema = z.object({
  type:       z.literal('session.prompt-request.resolved'),
  sessionId:  z.string(),
  requestId:  z.string(),
  reason:     z.enum([
    'decided', 'timeout',
    'cancelled-no-clients', 'cancelled-tool-completed',  // NEW: 'cancelled-tool-completed'
    'session-ended',
  ]),
  // NEW: who caused the resolution. Lets clients distinguish UX-significant
  // events ("approved by another client") from system-initiated ones (timeout,
  // session-ended). 'remote-adapter:<kind>' when a client posted prompt-response;
  // 'hub-stale-cleanup' when the hub auto-resolved a now-irrelevant approval;
  // null/missing for system actions with no actor.
  resolvedBy: z.string().nullable().optional(),
});

// NEW message: snapshot broadcast on every change to a session's user-set
// sticky configuration. Carries the full snapshot of all three fields so
// clients never need delta-merging logic. Gated on `state` capability.
export const SessionConfigChangedSchema = z.object({
  type:                z.literal('session.config-changed'),
  sessionId:           z.string(),
  pin:                 z.string().nullable(),
  quietUntil:          z.number().int().nullable(),
  sessionGateOverride: z.enum(['disabled','auto','always']).nullable(),
});

export const DownstreamMessageSchema = z.discriminatedUnion('type', [
  // ... existing ...
  SessionPromptRequestSchema, SessionPromptRequestResolvedSchema,
  SessionConfigChangedSchema,  // NEW
]);
export type SessionConfigChanged = z.infer<typeof SessionConfigChangedSchema>;
```

### `hub/src/approval-manager.ts`

```ts
import type { PromptQuestion } from '@sesshin/shared';

export type PromptOrigin =
  'permission' | 'ask-user-question' | 'exit-plan-mode' | 'enter-plan-mode';

export interface PendingApproval {
  // ... existing ...
  origin:    PromptOrigin;       // NEW (required)
  body?:     string;             // NEW (optional)
  questions: PromptQuestion[];   // NEW (required, may be empty)
}

open(input: {
  // ... existing ...
  origin:    PromptOrigin;
  body?:     string;
  questions: PromptQuestion[];
}): { request: PendingApproval; decision: Promise<ApprovalOutcome> }
```

`pendingForSession()` returns the new fields; `body` is omitted (not `undefined`) when absent so `JSON.stringify` matches the original wire frame's spread `...(rendered.body !== undefined ? { body: rendered.body } : {})`.

### `hub/src/registry/session-registry.ts`

```ts
interface RegistryEvents {
  // ... existing ...
  'config-changed': (info: SessionInfo) => void;  // NEW
}

// publicView() change: drop pin / quietUntil / sessionGateOverride from
// the strip list — they now belong on the wire.

setPin(id: string, msg: string | null): boolean {
  const s = this.sessions.get(id);
  if (!s) return false;
  if (s.pin === msg) return true;          // NEW: no-op short-circuit
  s.pin = msg;
  this.emit('config-changed', this.publicView(s));   // NEW
  return true;
}
// setQuietUntil and setSessionGateOverride mirror the same shape.
```

### `hub/src/ws/server.ts`

```ts
function capabilityRequiredFor(msgType: string): string | null {
  switch (msgType) {
    // ... existing ...
    case 'session.config-changed':       return 'state';   // NEW
    // ...
  }
}

onPromptResponse?: (
  sessionId: string,
  requestId: string,
  answers: PromptResponseAnswer[],
  clientKind: string,                    // NEW
) => boolean;
```

## Edge cases / invariants

### E1 — Subscribe / live-broadcast race for new approval

Subscribe handler sends `session.list`, then iterates `pendingForSession()`; meanwhile a fresh `approvals.open()` could fire its live broadcast. The new entry could appear in both the live broadcast (via the subscription that's already attached) and the replay snapshot.

**Resolution:** client-side idempotency. `debug-web/src/store.ts:61` already drops duplicate `requestId`. We formalize this as a wire contract: clients MUST treat `session.prompt-request` as idempotent on `(sessionId, requestId)`. No hub-side dedup; locking would be more complex than the harm it prevents.

### E2 — Replayed entry resolves between snapshot and send

`pendingForSession()` returns `[a]`; a tick later `a` is decided. The replay frame still ships, then `prompt-request.resolved` arrives via live broadcast. Client renders the card briefly then dismisses. Acceptable transient UI flicker; FIFO over the same WS connection keeps ordering predictable.

### E3 — Subscribe diff semantics

| Sequence | `prev` | `next` | Replayed |
|---|---|---|---|
| First subscribe | ∅ | `{A, B}` | `{A, B}` |
| Add session to set | `{A}` | `{A, B}` | `{B}` only |
| Same set re-sent | `{A, B}` | `{A, B}` | nothing — clients wanting refresh must close+reconnect |
| `'all'` → explicit subset | `'all'` (= live registry) | `{A}` | nothing — `A` was in `prev` |
| Explicit → `'all'` | `{A}` | `'all'` | `live registry \ {A}` |
| Unsub then re-sub | `{A,B}` → `{A}` → `{A,B}` | last step | `{B}` (correct: client may have missed updates while unsubscribed from B) |

### E4 — Session removed mid-replay

`pendingForSession(sid)` could race with `cancelForSession()` in the `session-removed` handler. The iteration is synchronous within a microtask; the race window is narrow. If the race triggers, the client receives a transient prompt-request frame, then `session.removed` (and the cancellation's `prompt-request.resolved` would also fire).

**New client-side requirement:** `removeSession(id)` MUST also clear `promptRequestsBySession[id]`. One-line addition to `debug-web/src/store.ts`.

### E5 — `setPin(id, sameValue)` no-op

`setPin('A', 'foo')` then `setPin('A', 'foo')`: second call returns `true` (the public contract is "did the session exist?", not "did anything change"), but does **not** emit `'config-changed'`. Same for `null === null`. Avoids idle UI churn.

### E6 — Capability matrix at subscribe time

| Caps declared | `session.list` (with config) | Pending prompt-request replay | `session.config-changed` (runtime) |
|---|---|---|---|
| `state` only | ✓ | ✗ | ✓ |
| `actions` only | ✗ | ✓ | ✗ |
| `state` + `actions` | ✓ | ✓ | ✓ |
| neither | ✗ | ✗ | ✗ |

`actions`-without-`state` is unusual but not blocked. Today (HEAD) all clients (only debug-web) declare both; gating is forward-looking for M5Stick (`state` only) and Telegram (`state + actions` likely).

### E7 — Hook handler invariant

This change is invisible to the hook handler. HTTP long-hold protocol unchanged. Decision flow unchanged. An entry resolves exactly once. The new replay machinery only redistributes already-known state to late-joining viewers.

## Testing matrix

### `shared/src/session.test.ts`

- `SessionInfoSchema` accepts `pin / quietUntil / sessionGateOverride` in all three states (missing / null / value).
- Rejects bad `sessionGateOverride` (non-enum string).

### `shared/src/protocol.test.ts`

- `SessionPromptRequestResolvedSchema` accepts `resolvedBy` as `'remote-adapter:debug-web'`, `'hub-stale-cleanup'`, `null`, missing.
- `SessionPromptRequestResolvedSchema` accepts `reason: 'cancelled-tool-completed'` (regression for the schema/code drift).
- `SessionConfigChangedSchema` parses; `DownstreamMessageSchema` discriminated union dispatches it.

### `hub/src/approval-manager.test.ts`

- `open()` requires `origin` and `questions` (TS-level + runtime).
- `pendingForSession()` includes `origin`, `body`, `questions` after `open()`.
- `body` is **absent** (not `undefined`) when not provided to `open()` — verified via `'body' in obj === false`.
- Returned entries are copies (mutating them does not affect internal state).

### `hub/src/registry/session-registry.test.ts`

- `publicView()` after `register()` includes `pin: null`, `quietUntil: null`, `sessionGateOverride: null`.
- `setPin('foo')` emits `'config-changed'` with the new value in the payload.
- `setPin('foo')` then `setPin('foo')` emits exactly once.
- `setPin(null)` on a session whose pin is already `null` does not emit.
- Same three tests for `setQuietUntil` and `setSessionGateOverride`.
- `'config-changed'` payload does not contain stripped fields (`claudeAllowRules`, `sessionAllowList`, etc.).
- Setters on unknown session id return `false` and do not emit.

### `hub/src/ws/connection.test.ts`

Approximately 13 new cases (~150 lines), using a real WS server fixture:

- `subscribe` replays pending `session.prompt-request` to a client with `actions` cap; the parsed frame is deep-equal to the original live broadcast.
- `subscribe` does not replay to client without `actions` cap.
- Overlap subscribe (`{A}` then `{A, B}`) does not double-replay `A`'s pending entries.
- Idempotent subscribe (same set twice) does not replay anything on the second call.
- Replay covers all pending entries when a session has multiple.
- `subscribe { sessions: 'all' }` replays pending across all live sessions.
- Replay frame matches the original live frame structurally (open → live-subscribed client receives live; new client subscribes → receives replay; deep-equal as parsed objects).
- Resolved entries are not replayed.
- Expired entries are not replayed (open with `timeoutMs: 10`, wait, subscribe).
- `setPin` while a `state`-capable client is subscribed → client receives `session.config-changed`.
- `setPin` on session A while client subscribed only to B → no message.
- `setPin` while client lacks `state` cap → no message.
- `session.config-changed` payload includes the current value of all three fields after a series of mutations.

### `hub/src/wire.test.ts` (new file or extension)

- `prompt-response` from a remote client triggers `prompt-request.resolved` with `resolvedBy: 'remote-adapter:<kind>'` and `reason: 'decided'`.
- `onExpire` (timeout) fires `prompt-request.resolved` with `resolvedBy: null` and `reason: 'timeout'`.
- Stale-cleanup (`onApprovalsCleanedUp`) fires `prompt-request.resolved` with `resolvedBy: 'hub-stale-cleanup'` and `reason: 'cancelled-tool-completed'`.
- `onLastActionsClientGone` fires `prompt-request.resolved` with `resolvedBy: null` and `reason: 'cancelled-no-clients'`.

### `debug-web/src/store.test.ts`

- `removeSession(id)` clears `promptRequestsBySession[id]` (new requirement).

### Manual verification (not in CI)

- Trigger a Bash prompt in a real claude session; while it's pending, refresh the debug-web page; verify the same prompt-card reappears with the same options and answering it lets the agent continue.
- Set `sesshin pin "deploying"` while debug-web is connected; verify the pin appears in the UI without reload.

## Wire contracts (formalized)

These were implicit; this issue makes them explicit.

1. Clients MUST treat `session.prompt-request` as idempotent on `(sessionId, requestId)`. The hub may re-send the same frame on subscribe-time replay even if the client was previously connected.
2. Clients MUST treat `session.config-changed` as a full-snapshot replacement, not a delta. All three fields are always present.
3. Clients MUST clear all per-session in-memory state (including any pending prompt-cards) on `session.removed`.

## Acceptance criteria

- [ ] All tests in the matrix above pass.
- [ ] Manual verification scenarios pass on a real claude session.
- [ ] `tsc --noEmit` clean across all packages.
- [ ] No change to hook handler (`packages/hook-handler/`).
- [ ] No change to internal REST contract (`packages/hub/src/rest/`) other than the existing `setPin/setQuiet/setGate` endpoints continuing to call into the now-emitting setters.

## Out of scope (follow-up issues)

To be filed as separate issues after this one lands:

1. **Sticky-config persistence across hub restart.** `pin`/`quietUntil`/`sessionGateOverride`/`sessionAllowList` are session-scoped user settings with no in-flight HTTP correlation; hub crash today loses them. Persisting to a small SQLite file or JSON snapshot is straightforward in isolation but is a different problem than this issue (which is about new clients seeing what the running hub already knows).
2. **Hook-handler protocol redesign.** Move from HTTP long-hold to a register-then-poll model so hub crash doesn't release approvals as `'ask'`. Requires coordinated changes on both hub and hook handler; informed by omnara's polling model. v2 roadmap.
3. **`lastEventId` persistence in debug-web.** Today `store.ts:29` keeps `lastEventId` in an in-memory `signal`, so reload loses the event-log replay benefit of `since`. Storing in `sessionStorage` would let reload resume the event log. ~30-line change, decoupled from this issue.

## Comparison to omnara (informational)

The omnara analysis at `docs/local/2026-05-04-omnara-analysis.md` arrives at this issue from a different transport paradigm: omnara polls a Postgres `messages` table, so "what's currently pending" is a natural query (`SELECT * WHERE requires_user_input AND NOT answered`) and reconnecting clients see it for free. Sesshin's event-driven WS model has no equivalent natural query, so the same property has to be engineered explicitly — that's what this issue does. The `resolvedBy` field maps to omnara's `agent_questions.answered_by_user_id`. The hub-crash scenario where the in-flight HTTP connection is lost has no equivalent in omnara because their hook handler is implicitly a polling client; this confirms why the persistence work in §"Out of scope" item 2 is non-trivial.
