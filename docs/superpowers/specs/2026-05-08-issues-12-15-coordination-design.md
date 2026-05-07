# Persistence + Catalog + Lifecycle: Issues #12–#15 Coordination

**Date:** 2026-05-08
**Status:** Design
**Closes:** #6, #12, #13, #14, #15

## Problem

Four open issues describe overlapping changes to the hub's persistence, protocol, and session-management surfaces:

- **#12** introduces a SQLite store for sessions / messages / actions / prefs.
- **#13** synthesizes hook events into a chat-style message stream.
- **#14** exposes a session catalog (live + ended) over REST and WS.
- **#15** removes the `pin` / `quietUntil` / `sessionGateOverride` sticky-config layer and replaces it with five lifecycle actions (`pause` / `resume` / `kill` / `rename` / `delete`). The original issue listed a sixth (`mark-complete`); we drop it because vanilla Claude Code has no "completed" concept and sesshin should not introduce one.

The dependency chain is `#12 → {#13, #15} → #14`. Each issue touches `packages/shared/src/protocol.ts`, `SessionRecord`, and the WS connection handler, so even a strictly-sequenced rollout has merge surface across PRs.

This spec coordinates the four issues into a single PR. Sesshin is a single-machine, internal-protocol project (no external clients today), so we delete legacy fields outright with no deprecation window. The spec also folds in three cleanups that emerge naturally from the same refactor:

1. Drop `claudeAllowRules` from the hub entirely. It was a passive mirror of `~/.claude/settings.json`'s `allowRules`; sesshin should keep auto-approve behavior consistent with vanilla Claude Code and not maintain its own copy.
2. Drop the `voice` capability — declared but unused.
3. Drop `checkpoint.json` and the `Checkpoint` module. SQLite becomes the sole persistence store.

## Scope

**In:**

1. New SQLite store at `~/.sesshin/state.db` with `sessions`, `messages`, `actions` tables (no `prefs` — see Decisions).
2. Persistor module that replaces `Checkpoint`, debounced writes to the `sessions` row + `metadata` JSON.
3. Per-session message synthesizer that folds `UserPromptSubmit` / `Stop` into `messages` rows and broadcasts `session.message`.
4. REST catalog endpoints `GET /api/v1/sessions` and `GET /api/v1/sessions/:id`, with paginated message replay.
5. Lifecycle handler with five actions, audit-recorded via the `actions` table.
6. `proc-state` reconciliation for accurate `paused` state across hub restarts and external signals.
7. New capabilities `messages`, `catalog`, `lifecycle`. New WS messages `session.message`, `session.ended`, `session.lifecycle`, `history.request`, `error`. Removed: `voice`, `history` capabilities; `session.config-changed` message; sticky-config REST endpoints; `sesshin-pin` / `sesshin-quiet` / `sesshin-gate` slash commands.
8. REST path version bump: all hub REST endpoints move under `/api/v1/`. Old `/api/...` paths return `410 Gone`.
9. Closes issue #6 (sticky-config persistence design — superseded).

**Out:**

- Codex / Gemini message synthesis (Claude Code only for now).
- Inline tool-call messages in the chat stream (only `agent-internal` text + `Stop.last_assistant_message`; `PreToolUse` / `PostToolUse` stay in the debug `events` stream).
- `EventBus` persistence (events remain in-memory; `messages` is the persisted user-facing stream).
- Server-side full-text search over messages.
- Cross-session tagging / labelling.
- Cross-machine catalog (sesshin is single-machine).
- Encryption at rest (`~/.sesshin/` is already private).

## Database schema (v1)

`PRAGMA journal_mode = WAL` is set on every connection open; `PRAGMA user_version` is bumped by the migration runner once all v1 statements succeed.

```sql
CREATE TABLE sessions (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  agent             TEXT NOT NULL,            -- claude-code | codex | gemini | other
  cwd               TEXT NOT NULL,
  pid               INTEGER,
  session_file_path TEXT,
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER,
  end_reason        TEXT,                     -- normal | interrupted | killed
  last_state        TEXT NOT NULL,
  claude_session_id TEXT,
  hidden            INTEGER NOT NULL DEFAULT 0,
  metadata          TEXT NOT NULL DEFAULT '{}'  -- JSON: substate, lastSummaryId, fileTailCursor, permissionMode
);

CREATE INDEX idx_sessions_started_at ON sessions(started_at DESC);
CREATE INDEX idx_sessions_state      ON sessions(last_state);

CREATE TABLE messages (
  id                  TEXT PRIMARY KEY,         -- ULID
  session_id          TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sender_type         TEXT NOT NULL,            -- user | agent | system
  content             TEXT NOT NULL,
  format              TEXT NOT NULL DEFAULT 'text',
  requires_user_input INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  source_event_ids    TEXT                      -- JSON array of session.event ids
);

CREATE INDEX idx_messages_session_created ON messages(session_id, created_at);

CREATE TABLE actions (
  id           TEXT PRIMARY KEY,                -- ULID
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,                   -- pause | resume | kill | rename | delete | approve | deny | inject
  payload      TEXT,                            -- JSON
  performed_by TEXT,                            -- client.id
  created_at   INTEGER NOT NULL
);

CREATE INDEX idx_actions_session_created ON actions(session_id, created_at);
```

`sessions.metadata` is the home for fields previously in `checkpoint.json`:

```jsonc
{
  "substate":         { /* StateMachineSubstate */ },
  "lastSummaryId":    "...",
  "fileTailCursor":   { "offset": 123, "inode": 456 },
  "permissionMode":   "default" | "acceptEdits" | "bypassPermissions" | "plan"
}
```

`lastHeartbeat` is **not** persisted. On hub restart it initializes to `Date.now()` (the standard grace period), and the wrapped CLIs that are still running will heartbeat fresh.

Migrations live in `packages/hub/src/storage/migrations/`. v1 = the schema above. Each migration step is idempotent (`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`), so a partial run on prior crash is safe to retry. `openDb` reads `PRAGMA user_version`, applies any missing migrations, and bumps the version.

## Persistor

`packages/hub/src/storage/persistor.ts` replaces `packages/hub/src/registry/checkpoint.ts`. Same listener pattern (`session-added` / `session-removed` / `state-changed` / `substate-changed`), same debounce config, but writes to SQLite instead of a JSON file:

- `session-added` → immediate `INSERT OR REPLACE INTO sessions(...)` with `started_at` and initial `last_state`.
- `session-removed` → immediate `UPDATE sessions SET ended_at = ?, end_reason = ?, last_state = ? WHERE id = ?`. Row is **not** deleted.
- `state-changed` / `substate-changed` → mark dirty; debounced flush updates `last_state` and re-serializes `metadata` JSON for that session.
- On hub shutdown: flush pending dirty rows.

WAL mode + a single hub process means `INSERT OR REPLACE` and `UPDATE` are atomic without the `tmp + rename` dance the JSON checkpoint needed.

Hub startup loads sessions from SQLite where `ended_at IS NULL` (still in-flight) and registers them. The 24-hour retention window for the in-memory copy of ended sessions stays in the registry; the SQLite row is permanent.

## proc-state reconciliation

`packages/hub/src/registry/proc-state.ts` reads `/proc/<pid>/status`'s `State:` field and returns one of `running` (R/S/D), `stopped` (T), `dead` (Z/X), or `gone` (PID does not exist). Linux-only; on other platforms returns `unknown` and reconciliation is a no-op (consistent with `session-liveness.ts`).

Reconciliation runs in three places:

1. **Hub startup**: after restoring sessions from SQLite, every session with a tracked `pid` gets a `proc-state` read. If `stopped`, registry state becomes `paused`; if `gone` or `dead`, the session is unregistered with `endReason = 'interrupted'`.
2. **Periodic**: piggybacks on the existing `SESSION_REAP_INTERVAL_MS` reaper. Each tick checks every live session's `proc-state`. Any drift (e.g., user manually `kill -CONT` from outside) corrects the registry state and emits `session.state-changed`.
3. **Post-action verification**: after `pause` (SIGSTOP) or `resume` (SIGCONT), the lifecycle handler reads `proc-state` once with a 50 ms wait. If the actual state doesn't match the intended state, the lifecycle action returns an error envelope and registry is left at the actual state.

`pause` is **not** persisted as the `paused` registry state — it's derived. After hub restart, the wrapped CLI is whatever signal-state it was in (the SIGSTOP didn't go away with the hub crash); the startup reconciliation reads `proc-state` and sets registry accordingly. This keeps the in-memory state honest without making "pause" survive across restarts as a sticky decision.

## Protocol additions

Capabilities (in `CapabilityEnum`):

```
+ 'messages'    // session.message + history.request
+ 'catalog'     // session.ended + subscribe.includeEnded
+ 'lifecycle'   // session.lifecycle upstream
- 'voice'       // unused
- 'history'     // semantic overlap with 'messages'; never wired to a feature
```

New downstream message `session.message`:

```ts
{
  type: 'session.message';
  sessionId: string;
  message: {
    id: string;                 // ULID
    senderType: 'user' | 'agent' | 'system';
    content: string;
    format: 'text' | 'markdown';
    requiresUserInput: boolean;
    createdAt: number;
  };
}
```

New downstream message `session.ended`:

```ts
{
  type: 'session.ended';
  sessionId: string;
  endedAt: number;
  endReason: 'normal' | 'interrupted' | 'killed';
}
```

New upstream message `session.lifecycle`:

```ts
{
  type: 'session.lifecycle';
  requestId: string;            // for error correlation
  sessionId: string;
  action: 'pause' | 'resume' | 'kill' | 'rename' | 'delete';
  payload?: { name?: string };  // required for 'rename'
}
```

New upstream message `history.request`:

```ts
{
  type: 'history.request';
  requestId: string;
  sessionId: string;
  beforeId: string | null;      // null = newest
  limit: number;                // 1..200
}
```

New downstream message `error` (universal envelope):

```ts
{
  type: 'error';
  code: string;                 // e.g. 'lifecycle.invalid-state' | 'history.out-of-range' | 'capability.required'
  message: string;
  sessionId?: string;
  requestId?: string;           // echo of the offending upstream requestId
}
```

`requestId` becomes an optional field on every upstream message that can fail (currently `session.lifecycle` and `history.request`). Clients that don't care about correlation can omit it.

`SubscribeSchema` gains `includeEnded: boolean` (default `false`).

`SessionInfo` schema, post-cleanup:

```ts
{
  id: string;
  name: string;
  agent: string;
  cwd: string;
  state: 'starting' | 'idle' | 'busy' | 'awaiting-input' | 'paused'
       | 'done' | 'interrupted' | 'killed';
  startedAt: number;
  endedAt: number | null;
  endReason: 'normal' | 'interrupted' | 'killed' | null;
  hidden: boolean;
  // removed: pin, quietUntil, sessionGateOverride, claudeAllowRules
}
```

## Protocol removals

- `voice` from `CapabilityEnum`.
- `history` from `CapabilityEnum` (the user-facing history surface is `messages`).
- `session.config-changed` downstream message and its broadcast wiring.
- `pin` / `quietUntil` / `sessionGateOverride` / `claudeAllowRules` fields from `SessionInfo` and `SessionRecord`.
- `RegisterBody.claudeAllowRules` field.

## REST surface

All hub REST endpoints move from `/api/...` to `/api/v1/...`. The router answers `410 Gone` for the un-versioned paths so a stale client gets a clear signal rather than a 404.

Removed:

- `POST /api/sessions/:id/pin`
- `POST /api/sessions/:id/quiet`
- `POST /api/sessions/:id/gate`
- `claudeAllowRules` field on `POST /api/sessions` (register)

Added:

- `GET /api/v1/sessions?state=&agent=&before=<startedAt>&limit=50&includeHidden=false` returns `{ sessions: SessionSummary[], hasMore: boolean }`.
- `GET /api/v1/sessions/:id` returns `SessionDetail` (summary + last 50 messages, paginated via WS `history.request` for older).

```ts
SessionSummary {
  id; name; agent; cwd; state;
  startedAt; endedAt; endReason;
  messageCount: number;
  lastMessage: { senderType, contentPreview, createdAt } | null;  // contentPreview = first 200 chars
  hidden: boolean;
}

SessionDetail extends SessionSummary {
  messages: Message[];                       // last 50, oldest-first
  // gitDiff field is reserved; landed by a future git-diff issue, not this PR
}
```

REST auth is unchanged from today's loopback model. (The bearer-token / identity-layer issue mentioned in #14 is a separate future change; this PR keeps the existing auth.)

## Lifecycle handler

`packages/hub/src/lifecycle/handler.ts`. Pure function: takes the `session.lifecycle` message + registry + signal sender, returns `{ ok: true }` or an error envelope. Always records to the `actions` table on attempt (success or failure), with `payload` capturing the requested action and the rejection reason if any.

| Action | Pre-condition | Effect | Audit kind |
|--------|---------------|--------|------------|
| `pause` | `state ∈ {idle, busy, awaiting-input}` | `process.kill(pid, 'SIGSTOP')`; verify proc-state = stopped | `pause` |
| `resume` | `state = paused` | `process.kill(pid, 'SIGCONT')`; verify proc-state = running | `resume` |
| `kill` | `state ∉ {done, interrupted, killed}` | `SIGTERM`; if alive after 3 s, `SIGKILL`; unregister with `endReason = 'killed'` | `kill` |
| `rename` | always valid; `payload.name` required | `SessionRecord.name = payload.name`; persistor flushes; broadcast `SessionInfo` update | `rename` |
| `delete` | `state ∈ {done, interrupted, killed}` | `UPDATE sessions SET hidden = 1`; broadcast `session.removed` | `delete` |

Pre-condition failures return `{ type: 'error', code: 'lifecycle.invalid-state', message: ..., sessionId, requestId }`.

`process.kill` targets the wrapped CLI's PID directly. Subagents (nested processes) go down with the parent; explicit process-group handling is out of scope for this PR.

Slash commands (local CLI surface, in `packages/cli/src/commands-bundle/`):

- `/sesshin-pause` / `/sesshin-resume` — operate on the current session.
- `/sesshin-kill` — operate on the current session.
- `/sesshin-rename <new name>` — operate on the current session.

`delete` has no slash-command surface — it only makes sense from a catalog view, so it's remote-client-only.

## Synthesizer

`packages/hub/src/synthesizer/messages.ts`. Per-session state machine wired to `EventBus`. Persists each emitted message via `messages.append(...)` before broadcasting `session.message` (so reconnect replay is consistent). State transitions:

```
idle:
  UserPromptSubmit{prompt}    → emit user message; open turn buffer
  (other events)              → ignore

turn-open:
  agent-output {text}         → append to turn buffer
  Stop{last_assistant_message}
                              → emit agent message with content = last_assistant_message
                                 requiresUserInput = true if EITHER
                                   (a) stop_hook_active === true (agent is asking a follow-up), OR
                                   (b) a PermissionRequest during this turn left the session in 'awaiting-input'
                                 close turn
  PreCompact / PostCompact    → emit system message "Conversation compacted"
                                 keep turn open
  SessionEnd                  → close turn without emitting
```

`PreToolUse` / `PostToolUse` are not synthesized into messages by default. The `includeToolMessages` capability flag is reserved for a future client opt-in but is not implemented in this PR.

`history.request` is the pagination path: hub looks up the `messages` table by `session_id` and returns up to `limit` rows older than `beforeId` (or the newest `limit` rows if `beforeId` is null), oldest-first, batched as `session.message` records.

Open question: `Stop` events without `last_assistant_message`. Treat as silent close; emit no agent message. Verify behavior against debug-web traces during implementation.

## Cross-cutting conventions

- **ULID generator**: `packages/shared/src/ids.ts` exports `ulid(): string` (Crockford base32, 26 chars, lex-sortable). Single hub-process generator. Used by `messages.id` and `actions.id`.
- **Audit policy**: every lifecycle action attempt — successful or rejected — appends to `actions` with `kind`, JSON `payload`, `performed_by = client.id`, `created_at`. Rejections include the rejection reason in `payload.reason`. Future approve/deny/inject actions follow the same shape.
- **Migration idempotency**: every step in `migrations/*.ts` must tolerate being re-run. Use `IF NOT EXISTS` for `CREATE TABLE` / `CREATE INDEX`; use `INSERT OR IGNORE` for any seeded rows.
- **Error envelope**: all WS errors use the `error` type with `code` namespaced as `<domain>.<reason>`. Currently defined: `lifecycle.invalid-state`, `lifecycle.payload-required`, `lifecycle.signal-failed`, `history.out-of-range`, `history.session-not-found`, `capability.required`.
- **Persistor write timing**: `INSERT OR REPLACE` on register; `UPDATE` on state changes (debounced); `UPDATE` on unregister (immediate, sets `ended_at`/`end_reason`).
- **Single PR commits**: development order inside the PR, for git log readability — (1) shared/ids.ts, (2) shared/protocol.ts changes, (3) storage/db + migrations, (4) Persistor + checkpoint deletion, (5) sessions wiring + proc-state reconciliation, (6) lifecycle handler + slash commands, (7) synthesizer + messages wiring, (8) REST catalog + path version bump, (9) WS connection updates + capability gating, (10) tests catch-up + remove obsolete tests.

## Testing strategy

- **Unit**: persistor debounce + flush, migration idempotency (run migrations twice in a fresh DB), synthesizer state machine for each event sequence, lifecycle handler for each action × pre-condition matrix, proc-state parsing (sample `/proc/<pid>/status` strings — covers existing field-position assumption), error envelope codes.
- **Integration**: round-trip a session lifecycle (register → state changes → unregister → restart hub → reconcile → query catalog); verify `messages` replay is identical pre-/post-restart; verify `pause` survives hub crash via proc-state reconciliation (SIGSTOP, kill hub process, restart hub, assert registry shows `paused`); verify a manually-resumed (external `kill -CONT`) session has its registry state corrected on the next reaper tick.
- **Removal verification**: grep the tree post-PR for `claudeAllowRules`, `sessionGateOverride`, `pin`, `quietUntil`, `voice`, `session.config-changed`, `Checkpoint` — should all be zero hits.
- **Tests deleted**: `packages/hub/src/registry/checkpoint.test.ts`, any pin/quiet/gate REST or slash command tests.

## Open questions

- **`PreCompact` / `PostCompact` synthesis** as a system message: confirm the divider rendering on debug-web doesn't break the existing event display. Assume yes; revisit if it causes UI regressions.
- **`history.request` rate-limiting**: do we cap requests-per-second per WS connection? Probably yes (`limit ≤ 200` already bounds size; rate limits can be added if abuse appears). Not in this PR.
- **`hidden` in catalog default**: `GET /api/v1/sessions?includeHidden=false` is the default. Is there a UI affordance to ever show hidden sessions? Out of scope for this PR — flag exists in the REST surface, UI question is for #14's consumer.

## Out of scope (later issues, listed for clarity)

- Bearer-token identity layer for REST.
- Codex / Gemini synthesizer branches.
- Inline tool-call messages in the chat stream.
- Cross-session search.
- Git-diff field on `SessionDetail` (depends on a separate git-diff issue).
- Remote session creation / launcher surface.
- `EventBus` persistence (events stay in-memory by design).
