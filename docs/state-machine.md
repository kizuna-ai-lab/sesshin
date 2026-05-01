# Session state machine

Each session has one **primary state** and a **substate** object. Primary
state changes are coarse and trigger client notifications. Substate changes
are fine-grained and broadcast at lower frequency.

## Primary states

| state | meaning | enter when | exit when |
|-------|---------|------------|-----------|
| `starting` | CLI registered, agent process spawning | session.added | first `SessionStart` hook OR first PTY output |
| `idle` | agent is alive but not currently doing work | `SessionStart`, `Stop` without pending question | `UserPromptSubmit` |
| `running` | agent is actively producing output / using tools | `UserPromptSubmit`, first `PostToolUse` after idle | `Stop` |
| `awaiting-input` | agent stopped and is asking the user a question | `Stop` whose summary signals an open question | next `UserPromptSubmit` |
| `awaiting-confirmation` | agent is asking permission for a tool call | `PreToolUse` with permission required | `PreToolUse` permission resolved (`PostToolUse`, or rejection from arbiter) |
| `error` | agent reported a tool failure or fatal error | `StopFailure`; `PostToolUse` with error payload | `UserPromptSubmit` OR explicit `retry` action |
| `done` | session completed normally | `SessionEnd` | terminal |
| `interrupted` | session terminated unexpectedly (CLI process death w/o `SessionEnd`) | CLI heartbeat lost AND process gone | terminal |

`disconnected` is **not** a primary state. The hub knows the session is alive
locally even when no WS clients are listening. Connectivity from the client's
point of view is reported via `substate.connectivity`.

## Substate

```ts
type Substate = {
  currentTool: string | null          // e.g. "Read", "Edit", "Bash"
  lastTool: string | null
  lastFileTouched: string | null      // absolute path
  lastCommandRun: string | null
  elapsedSinceProgressMs: number
  tokensUsedTurn: number | null
  connectivity: "ok" | "degraded" | "offline"
  stalled: boolean
}
```

Substate is updated continuously inside the hub. It is broadcast to clients:

- Whenever the primary state changes.
- On every tool change (`currentTool` flips).
- Every 5 seconds while in `running`, if anything else changed.
- On stall detection.

## Normalized hook event vocabulary

Sesshin uses a single normalized event set internally. Per-agent
adapters in the hook handler translate native event names to this set:

| Sesshin event | Claude Code | Codex | Gemini CLI |
|---------------|-------------|-------|------------|
| `SessionStart` | `SessionStart` | `SessionStart` | `SessionStart` |
| `UserPromptSubmit` | `UserPromptSubmit` | `UserPromptSubmit` | `BeforeAgent` |
| `PreToolUse` | `PreToolUse` | `PreToolUse` | `BeforeTool` |
| `PostToolUse` | `PostToolUse` | `PostToolUse` | `AfterTool` |
| `Stop` | `Stop` | `Stop` | `AfterAgent` |
| `StopFailure` | `StopFailure` | (n/a; encoded as `Stop` with error payload) | (n/a; encoded as `AfterAgent` with error payload) |
| `SessionEnd` | `SessionEnd` | `SessionEnd` | `SessionEnd` |

Gemini-only events (`BeforeModel`, `AfterModel`, `BeforeToolSelection`,
`PreCompress`, `Notification`) are passed through to clients as
`session.event` with `kind: "agent-internal"` and a Gemini-specific
payload. The state machine ignores them.

Codex-only events (`PermissionRequest`) are mapped to the same state
transition as `PreToolUse` with the permission-required flag.

## Hook event → state transitions

(Using the normalized vocabulary above.)

| hook event | from state | to state | side effects |
|------------|------------|----------|--------------|
| `SessionStart` | `starting` | `idle` | initial state broadcast |
| `UserPromptSubmit` | `idle`, `awaiting-input`, `error` | `running` | record source (laptop vs adapter); reset `elapsedSinceProgressMs` |
| `PreToolUse` (permission required) | `running` | `awaiting-confirmation` | broadcast `attention` if confirmation deadline approaches |
| `PreToolUse` (no permission) | `running` | `running` | substate update only (`currentTool`) |
| `PostToolUse` | `awaiting-confirmation`, `running` | `running` | substate update (`lastTool`, `lastFileTouched`, etc.); error payload may transition to `error` |
| `Stop` (clean) | `running` | `idle` | trigger summarizer |
| `Stop` (with question, see heuristic below) | `running` | `awaiting-input` | trigger summarizer; broadcast `attention` |
| `StopFailure` | `running` | `error` | trigger summarizer; broadcast `attention` with severity `error` |
| `SessionEnd` | any | `done` | persist final summary, broadcast removal |

### "Stop with question" heuristic

The agent does not signal "I'm waiting on the user" explicitly. We infer it
from the summarizer's output:

- If the summarizer sets `needsDecision: true`, treat the `Stop` as
  transitioning to `awaiting-input`.
- Otherwise, transition to `idle`.

This couples the state machine to the summarizer's judgment. Acceptable for
v1; revisit when more reliable signals are available (e.g. SDK-level "agent
is awaiting input" hooks if and when those land).

If the summarizer fails to produce a summary, the fallback is `idle`. This
errs on the side of false negatives (missed prompts) rather than false
positives (spurious "your attention is needed" alerts).

## Stall detection

Independent watchdog tracks `elapsedSinceProgressMs`: time since the last
hook event or PTY chunk while in `running`.

- At 60 s: substate `stalled: true` is broadcast. No notification fired.
- At 5 minutes: a `session.attention` event is fired with severity `info` and
  reason `stalled`. The summarizer is also triggered to produce a "still
  going" summary describing the most recent activity.
- At 30 minutes: severity escalates to `warning`. No further escalation in
  v1.

Stall detection resets when any progress occurs.

## Notification policy (state transition → device behavior)

These are suggested defaults. Per-user configurability is a v1.5 concern.

| transition | M5Stick | Telegram | Watch (future) |
|------------|---------|----------|----------------|
| → `awaiting-input` | beep + green light | message | haptic |
| → `awaiting-confirmation` | beep + amber light | message with action buttons | haptic |
| → `error` | strong beep + red light | message + alert formatting | strong haptic |
| → `done` | soft chime | summary message | gentle haptic |
| stalled (info) | soft beep | message | (silent) |
| stalled (warning) | beep + amber light | message | haptic |

Adapters request the right capability subset and decide locally what to do
with `session.state` and `session.attention` events. The hub does not push
"please vibrate now" commands; it pushes facts.

## Source attribution

Every transition that follows a `UserPromptSubmit` records `source` on the
event:

- `laptop` — typed locally into the wrapped PTY.
- `remote-adapter:<adapter-id>` — sent via WS protocol from a registered
  adapter.

Adapters that produce input MUST identify themselves on connect via
`client.identify.client.kind`. The hub records the connection's adapter id
and tags subsequent input events with it. This makes audit and history
("who did what where") tractable across all clients.

## Input arbiter and state

The input arbiter (a hub component) consults the current state before
forwarding remote input to the PTY:

| state | accept laptop input | accept remote input |
|-------|--------------------|--------------------|
| `starting` | yes | reject (`error: not-ready`) |
| `idle` | yes | yes |
| `running` | yes (typed-ahead, agent will see it on next prompt) | reject by default; accept only if user has enabled "remote interrupt" mode for this session |
| `awaiting-input` | yes | yes |
| `awaiting-confirmation` | yes | yes (this is the primary remote-input case for the M5Stick + IM use cases) |
| `error` | yes | yes |
| `done`, `interrupted` | reject | reject |

Laptop input is never blocked or queued. Remote input may be queued if the
state is non-acceptable; the hub returns a `server.error` with
`code: "input-queued"` and resolves the queue when the state next allows it.
v1 implements a simple FIFO queue with a 60-second timeout; rejected items
become `attention` notifications back to the originating adapter.

If both laptop and a remote source attempt to inject input simultaneously
during `awaiting-input`, the laptop wins and the remote item is queued
behind it.
