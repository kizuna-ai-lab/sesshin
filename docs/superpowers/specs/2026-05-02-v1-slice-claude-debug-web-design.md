# Sesshin v1 — first slice design

- **Date:** 2026-05-02
- **Status:** approved (working design; implementation plan to follow)
- **Slice scope:** the smallest end-to-end vertical that exercises Sesshin's
  complete data path on a single agent (Claude Code) with a single client
  (browser-based debug web) and full bidirectional flow (events out, input in).
- **Builds on:** the validated direct-API recipes in
  `docs/validation-log.md` and the architectural commitments in
  `docs/architecture.md`, `docs/protocol.md`, `docs/state-machine.md`,
  `docs/summarizer.md`. Where this spec contradicts those documents, this
  spec wins (the design baseline was written before any code; this is the
  first refinement against an implementable scope).

---

## 1. Goals and non-goals

### Goals

- Prove the full Sesshin data path works end-to-end on real software:
  - User runs `sesshin claude` in a terminal exactly as they'd run `claude`.
  - Their existing claude experience is preserved completely (settings, MCP,
    skills, plugins, slash commands, CLAUDE.md).
  - A browser opened to `http://127.0.0.1:9662` shows session state, live
    summaries produced by Mode B′ (direct Anthropic Messages API), and an
    event timeline.
  - The user can click action buttons (`continue`, `stop`, `approve`,
    `reject`, etc.) or type free-form text in the browser, and that input
    reaches the running claude session.
- Hold the architecture invariants documented in `docs/architecture.md`:
  three-process layout (CLI / hub / browser), per-session OAuth-direct
  summarization, append-only event flow, capability-gated subscriptions.
- Make the WS protocol concrete enough that the next slice (Telegram
  adapter) can be written without modifying it.

### Non-goals

- Codex and Gemini support. The protocol leaves room; the agent adapter
  layer leaves room; only `agents/claude/` is implemented in this slice.
- Telegram, M5Stick, watch, mobile clients. The debug web is the only
  client.
- Network modes other than localhost. No LAN binding, no Tailscale, no
  Cloudflare Tunnel. The WS/HTTP server binds `127.0.0.1` only.
- Token-based auth on the WS. Anyone with shell access on the host
  already has total control; security ceremony for localhost is
  premature.
- Stall detection, summary deduplication, "force re-summarize" actions.
- Input queuing, multi-source priority arbitration beyond "laptop wins,
  remote rejected during `running`."
- Persistent quota / spend tracking across sessions.
- Per-project sesshin config files.
- Real-API smoke tests in CI (live-API prototypes stay manual; CI uses
  recorded responses).

---

## 2. Architecture

```
   ┌─────────────────────────────── User's laptop ──────────────────────────────┐
   │                                                                            │
   │   Terminal A (user)                Background                  Browser     │
   │   ─────────────                    ───────────                 ───────     │
   │                                                                            │
   │   $ sesshin claude                                                         │
   │     │                                                                      │
   │     │ spawn-pty(claude,                                                    │
   │     │   --settings=/tmp/sesshin-<id>.json)  hook events                    │
   │     │                                       (HTTP POST)                    │
   │     ▼                                            │                         │
   │   ┌──────────┐  PTY  ┌─────────────────────┐    │   ┌──────────────────┐   │
   │   │ user TTY │◄────►│  sesshin-cli proc.  │────┘   │  sesshin-hub     │   │
   │   │          │      │                     │        │  (singleton)     │   │
   │   │ types,   │      │  PTY wrap, stdio    │        │                  │   │
   │   │ sees     │      │  passthrough,       │        │  - registry      │   │
   │   │ output)  │      │  register session,  │◄───────┤  - WS server     │   │
   │   │          │      │  accept input from  │ inject │  - REST :9663    │   │
   │   └──────────┘      │  hub→PTY pipe       │ input  │  - observers/    │   │
   │                     └─────────────────────┘        │  - state machine │   │
   │                                                    │  - summarizer    │   │
   │                                                    │  - input arbiter │   │
   │                                                    │  - serves SPA    │   │
   │                                                    └────┬─────────────┘   │
   │                                                         │ WS + HTTP       │
   │                                                         │ on :9662        │
   │                                                         ▼                 │
   │                                                  ┌────────────────────┐   │
   │                                                  │  Debug web SPA     │   │
   │                                                  │  - session list    │   │
   │                                                  │  - state badge     │   │
   │                                                  │  - latest summary  │   │
   │                                                  │  - event timeline  │   │
   │                                                  │  - action buttons  │   │
   │                                                  │  - text input box  │   │
   │                                                  └────────────────────┘   │
   └────────────────────────────────────────────────────────────────────────────┘
```

Three architectural commitments specific to this slice (call out for
implementation review):

- **Hook config is per-invocation.** `sesshin-cli` writes a temp settings
  file at `/tmp/sesshin-<sessionId>.json` containing only the hook handler
  config, then passes `--settings` to claude. Nothing in
  `~/.claude/settings.json` is touched. The temp file is deleted on
  `cli` exit.

- **Hub auto-spawns on first `sesshin claude`** (itwillsync pattern).
  Idempotent: if a hub is already running, the CLI registers with it.
  Hub auto-shuts-down 30 s after the last session unregisters.

- **No tokens for the v1 debug web.** The hub binds the WS/HTTP server
  to `127.0.0.1` only. Token-in-URL ceremony lands when network modes
  do.

---

## 3. Components

Five packages in a `pnpm` workspace. Build with `tsup`, test with `vitest`.
ESM throughout.

### 3.1 `@sesshin/shared`

Pure types and small utilities consumed by every other package. No I/O;
usable from the browser SPA too.

- **Owns:** protocol message types (`ClientIdentify`, `ServerHello`,
  `SessionInfo`, `Summary`, `Event`, `InputAction`, etc.), the
  normalized hook event vocabulary, the action enum
  (`continue|stop|retry|fix|approve|reject|...`), `zod` schemas for
  every wire type, per-session NaCl-secretbox crypto helpers
  (`deriveKey`, `encrypt`, `decrypt`).
- **Used by:** every other package.
- **Depends on:** `zod`, `tweetnacl`, `tweetnacl-util`.

### 3.2 `@sesshin/hub`

The daemon. Singleton per machine. The brains.

- **Owns:**
  - Session registry (in-memory + JSON checkpoint at
    `~/.cache/sesshin/sessions.json`, debounced 100 ms).
  - Internal REST on `127.0.0.1:9663`:
    - `POST /api/sessions` — register
    - `DELETE /api/sessions/:id` — unregister
    - `POST /api/sessions/:id/heartbeat` — keepalive
    - `POST /api/sessions/:id/inject` — hub-internal: CLI receives input from hub via this loopback (CLI's own callback)
    - `POST /api/sessions/:id/raw` — CLI streams PTY output chunks for the `raw` capability
    - `POST /hooks` — hook handler ingest
    - `GET /api/health` — status check, used by CLI startup probe
  - Public WS+HTTP on `127.0.0.1:9662`:
    - `GET /` — debug-web SPA static assets
    - `WS /v1/ws` — Sesshin WS protocol per `docs/protocol.md`
  - Event bus, per-session state machine (`docs/state-machine.md`).
  - **`observers/` subsystem** — pluggable normalized-event sources:
    - `observers/hook-ingest.ts` — receives POSTs from
      `@sesshin/hook-handler` at `/hooks`. Synchronous "agent just did X"
      signal.
    - `observers/session-file-tail.ts` — tails Claude's append-only
      session JSONL
      (`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`). Catches
      what hooks truncate (full tool args + results), reconstructs state
      on hub restart, fills gaps for events without hook coverage.
    - `observers/pty-tap.ts` — receives raw PTY chunks from the CLI
      via REST. Used for the `raw` debug-web capability and as a
      last-resort fallback signal source.
    - **Extension space (named, not built v1):**
      `observers/proc-tree.ts`, `observers/cwd-watch.ts`,
      `observers/osc-bell.ts`.
  - **Per-agent adapter layer** (`agents/{claude}/`) — translates each
    agent's hook event names, JSONL record shapes, and credential file
    layouts into the normalized vocabulary. v1 ships only
    `agents/claude/`.
  - Summarizer worker (`summarizer/{mode-b-prime,mode-b,heuristic}.ts`).
  - Input arbiter (`input-arbiter.ts`).
- **Used by:** `@sesshin/cli`, `@sesshin/hook-handler`, browsers.
- **Depends on:** `@sesshin/shared`, `ws`, `node:http`. No subprocess
  for the Mode B′ hot path; only Mode B fallback spawns `claude -p`.

### 3.3 `@sesshin/cli`

The user-facing entry point: `sesshin claude`.

- **Owns:**
  - PTY wrap of the agent (using `node-pty`).
  - Per-invocation hook-config tempfile generation (Section 4.2).
  - Auto-spawn of the hub if not running (binary spawn, detached).
  - Registration with hub via REST.
  - Heartbeat every 10 s.
  - Transparent stdin/stdout passthrough so the user's terminal
    experience is unchanged (raw mode, resize handling, BEL passthrough).
  - Receiving input-from-hub messages and writing them to the PTY's
    stdin.
  - Cleanup on exit (DELETE session, unlink tempfile, restore terminal).
- **Used by:** the user from a terminal.
- **Depends on:** `@sesshin/shared`, `node-pty`. Spawns the
  `@sesshin/hub` binary by path, not as a JS dep.

### 3.4 `@sesshin/hook-handler`

A tiny binary that Claude invokes when a hook fires. Reads JSON from
stdin, normalizes the event name to Sesshin's vocabulary, POSTs to
`http://127.0.0.1:9663/hooks`, exits 0.

- **Owns:** ~80 LOC of Node script. No state. Three rules:
  1. Total wall-clock limit: 250 ms. If POST doesn't return in 250 ms,
     drop and exit 0. Claude never sees a delay > 250 ms.
  2. Always exit 0. A non-zero exit could abort the user's turn.
  3. No stdout. v1 always emits empty stdout.
- **Used by:** Claude Code (and later Codex / Gemini) when fired by hook
  events.
- **Depends on:** `@sesshin/shared` types only. Uses `node:fetch`.

### 3.5 `@sesshin/debug-web`

The browser SPA. Vite + Preact (or React if preferred; Preact is half
the bundle size).

- **Owns:**
  - Session list view.
  - Per-session detail view (state badge, latest summary card, event
    timeline, action button row, text input box).
  - WS client wrapper (reconnect with backoff, heartbeat handling,
    `since`-based replay on reconnect).
  - Action dispatcher (action buttons → WS `input.action` messages).
- **Used by:** anyone who opens `http://127.0.0.1:9662` while the hub
  is running.
- **Depends on:** `@sesshin/shared`. Built artifact (HTML/CSS/JS) is
  bundled into `@sesshin/hub` at build time so the hub serves it at `/`.

### 3.6 Binary discovery

Two binaries need to be discoverable at runtime: the hub (CLI spawns it
when not running) and the hook handler (CLI writes its absolute path
into the temp settings file).

The pnpm workspace produces three runnable artifacts:

- `@sesshin/cli` → `bin/sesshin` (the user-facing entry; on PATH after
  `pnpm install -g` or `npm i -g`).
- `@sesshin/hub` → `bin/sesshin-hub` (singleton daemon).
- `@sesshin/hook-handler` → `bin/sesshin-hook-handler` (one-shot hook
  binary).

At runtime, the CLI resolves each sibling binary via `import.meta.url`
+ relative path within the same package install. Concretely: when the
CLI's `bin/sesshin` is invoked, `import.meta.resolve("@sesshin/hub/bin/sesshin-hub")`
yields the hub binary path, and similarly for the hook handler. This
works for global installs, local installs, and `pnpm dev` runs alike.

Override hook for development and exotic deployments: env vars
`SESSHIN_HUB_BIN` and `SESSHIN_HOOK_HANDLER_BIN`, if set, take
precedence over package resolution.

### 3.7 Boundaries the design holds

- **Hub is the only stateful process.** CLI is stateless (just bridges
  PTY to hub). Hook handler is one-shot. Web is rendered from hub state.
- **Protocol types live in one place.** `@sesshin/shared` defines the
  wire format; the Node hub and the browser SPA both import it. No
  drift.
- **Summarizer is one folder inside the hub** for v1. Refactoring out
  is deferred until a second consumer appears.
- **`@sesshin/cli` does not depend on hub code at the JS level.** It
  speaks to the hub purely over HTTP/WS, so the CLI can be killed and
  restarted while the hub keeps running.
- **One normalized event stream.** All observers emit events shaped
  by `@sesshin/shared`'s vocabulary. The state machine, summarizer,
  and clients don't care which observer produced an event.

---

## 4. Data flow

### 4.1 Cold start

```
1. User: $ sesshin claude
2. CLI checks if hub is running on 127.0.0.1:9663 (HEAD /api/health).
   Not running → CLI spawns the hub binary detached, waits for /api/health 200.
3. CLI generates sessionId (8 random hex bytes) and writes a HOOKS-ONLY
   settings file:
     /tmp/sesshin-<sessionId>.json

   The file's only top-level key is `hooks`. Nothing else: no env override,
   no model, no permissions, no MCP servers, no system prompt overrides.

   Each hook entry sets per-hook env:
     {
       "hooks": {
         "SessionStart": [{ "matcher":"*", "hooks":[{
            "type":"command",
            "command": "<absolute path to @sesshin/hook-handler binary>",
            "env": {
              "SESSHIN_HUB_URL": "http://127.0.0.1:9663",
              "SESSHIN_SESSION_ID": "<sessionId>",
              "SESSHIN_AGENT": "claude-code"
            }
         }]}],
         "UserPromptSubmit": [...same shape...],
         "PreToolUse":      [...],
         "PostToolUse":     [...],
         "Stop":            [...],
         "StopFailure":     [...],
         "SessionEnd":      [...]
       }
     }

4. CLI POSTs /api/sessions to register:
     { id, agent:"claude-code", cwd, pid: process.pid, sessionFilePath }
   The pid is the CLI process's own pid (NOT claude's, which doesn't exist
   yet at step 4). Hub crash recovery uses process.kill(pid, 0) on this
   value to detect dead sessions (Section 5.2). claude's pid is captured
   later from node-pty for the PTY lifecycle but is not registered with
   the hub.

   The sessionFilePath is computed from cwd:
     ~/.claude/projects/<encoded(cwd)>/<sessionId>.jsonl
   (Claude itself writes there once running.)
5. Hub starts session-file-tail observer for that path (file may not exist
   yet; tail handles that gracefully).
6. CLI calls node-pty.spawn("claude", ["--settings", "/tmp/sesshin-<id>.json"])
   with raw mode and full stdio passthrough. User sees claude exactly as
   before. Their existing settings layers (~/.claude/settings.json,
   ~/.claude/settings.local.json, .claude/settings.json,
   .claude/settings.local.json) all still load — our --settings is additive.
7. CLI starts pty-tap: tees PTY output (compressed/throttled,
   scrollback-bounded) to /api/sessions/<id>/raw on a streaming POST.
   Only consumed by hub if a client has subscribed to the `raw` capability.
8. CLI sends heartbeat to /api/sessions/<id>/heartbeat every 10 s.
```

### 4.2 What stays untouched (the explicit invariant)

The principle: `sesshin claude` is exactly `claude`, plus our hook handler.
Nothing subtracted. Specifically untouched:

- `~/.claude/settings.json` and `~/.claude/settings.local.json`
- `<cwd>/.claude/settings.json` and `<cwd>/.claude/settings.local.json`
- `~/.claude/keybindings.json`
- All `CLAUDE.md` files (user, project, anywhere)
- MCP server configs (loaded via the user's existing `.mcp.json` and settings)
- Skills (user, project, plugin)
- Slash commands, agents, plugins
- Auto-memory, LSP integration, background prefetches
- `~/.claude/.credentials.json` — hub READS but only writes back atomically
  during refresh, preserving mode 0600 and concurrent-read safety.

The summarizer's Mode B fallback (`claude -p`) is a separate, isolated
process and IS minimal-context-by-design (`--tools "" --no-session-persistence`
etc.); that doesn't affect the user's primary session.

### 4.3 Browser attaches

```
9.  User opens http://127.0.0.1:9662 in a browser.
10. Hub serves the debug-web SPA (static assets bundled at build time).
11. SPA opens WS to ws://127.0.0.1:9662/v1/ws (no token; localhost-only bind).
12. SPA sends client.identify {
      kind:"debug-web",
      capabilities:["summary","events","raw","actions","state","attention"]
    }.
13. Hub responds server.hello.
14. SPA sends subscribe { sessions:"all", since:null }.
15. Hub responds with session.list snapshot, then begins streaming live events.
```

### 4.4 A turn happens

```
16. User types "make tests green" into the claude CLI.
17. claude fires UserPromptSubmit hook → hook-handler POSTs to /hooks:
     { agent:"claude-code", sessionId, ts, event:"UserPromptSubmit",
       raw:{ original event JSON } }
18. Hub's hook-ingest observer normalizes and emits onto event bus.
19. State machine: idle → running. Substate.elapsedSinceProgressMs reset.
20. Hub broadcasts session.state and session.event to all subscribers.
21. Meanwhile, claude has appended the user message to its session JSONL.
    session-file-tail picks up the new line, also normalizes, emits.
    Dedup against the hook-ingest event (same sessionId+turnId+kind in <2s):
    file-tail event is enriched into the existing event (full tool args/
    results that hooks truncated), no duplicate broadcast.
22. claude calls tools (Read, Edit, Bash). Each fires PreToolUse / PostToolUse
    hooks. State machine stays in `running`; substate.currentTool updates per
    tool. Hub broadcasts session.event for each, with full payload from
    file-tail where available.
23. claude finishes the turn. Stop hook fires → hook-ingest emits a Stop event.
24. State machine: running → idle.
25. Summarizer trigger: hub assembles inputs (prev summary + new events
    since last summary, truncated to ~2k tokens budget), invokes Mode B′:
      POST https://api.anthropic.com/v1/messages?beta=true
      with the verified header recipe + `system` array prefix
      ("You are Claude Code, Anthropic's official CLI for Claude.").
26. ~1 s later: summary returned. Hub stores it, broadcasts session.summary.
27. SPA renders: state badge flips idle, summary card updates, event
    timeline appends.
```

### 4.5 User clicks "approve" on the browser

```
28. SPA sends input.action { sessionId, action:"approve" }.
29. Hub input-arbiter receives. Checks session state — `idle` after Stop,
    so accept. Maps "approve" → "y\n" (per-agent action map; for v1 slice
    Claude only).
30. Hub POSTs /api/sessions/<id>/inject with
    { data:"y\n", source:"adapter:debug-web" }.
31. CLI receives, writes "y\n" to its PTY's stdin. claude sees it as if
    typed.
32. claude proceeds. UserPromptSubmit-equivalent hook may fire (treated as
    adapter source via the source field). Cycle returns to step 18.
```

### 4.6 Clean shutdown

```
33. User: Ctrl-D in claude → claude exits cleanly. SessionEnd hook fires.
34. State machine: any → done. Hub broadcasts session.removed.
35. CLI sees PTY process exit, calls DELETE /api/sessions/<id>, removes the
    /tmp/sesshin-<id>.json settings file, exits.
36. Hub: if no sessions remain, starts a 30 s grace timer. If still empty
    at 30 s, hub exits. /tmp/sesshin-* are already gone, hub state JSON
    checkpoint flushed.
```

### 4.7 Three things to call out

- **Dedup window between hook-ingest and session-file-tail is small (~2 s).**
  Hooks usually arrive first because they're synchronous; file tail catches
  up after claude flushes. The dedup key is `(sessionId, turnId, kind)`
  where `turnId` is taken from claude's own JSONL when available, else
  synthesized from `(ts, kind)`.

- **PTY raw stream is opt-in for clients.** v1 debug-web subscribes to it
  so it's flowing constantly. Future M5Stick / Telegram clients will not
  subscribe; the CLI will keep capturing it but the hub buffers a small
  ring (~256 KiB) and trims, never holds the whole transcript.

- **Input arbitration is simple.** Acceptance rules: laptop input always
  allowed; remote input allowed when state ∈
  {`idle`, `awaiting-input`, `awaiting-confirmation`}; rejected with
  `code:"input-busy"` otherwise. No queue in v1.

---

## 5. Error handling

### 5.1 CLI startup failures

| Failure | Behavior |
|---|---|
| Hub unreachable AND fails to spawn | CLI prints actionable error pointing at `~/.cache/sesshin/hub.log`, exits non-zero. claude does not start. |
| Hub answers but `/api/health` 5xx (stale hub) | CLI sends DELETE on `/api/health/stale-shutdown`, waits 1 s, respawns hub. |
| Port 9662 or 9663 already in use by something else | Hub fails to bind; CLI surfaces error with the conflicting PID (if `lsof`-able). |
| `claude` binary not on PATH | CLI exits non-zero with a hint. Sesshin does not ship a claude install. |
| PTY spawn fails (missing `node-pty` prebuild) | CLI exits non-zero pointing at platform-specific install instructions. |
| `--settings` flag unrecognized (very old claude) | CLI prints "your `claude` is too old; minimum 2.x" and exits. |
| Verification gate 1 (Section 7) reveals `--settings` REPLACES user hooks rather than merging them | CLI auto-detects this by reading the user's hook config at startup and composes user hooks + Sesshin hooks into the same temp file. User-visible behavior is unchanged; one log line at first run records the fallback path is active. |

Cleanup invariant: the temp settings file is `unlink`ed in
`process.on('exit')` AND on the uncaught-exception path AND on
SIGINT/SIGTERM. If sesshin is `kill -9`'d, the file leaks and is cleaned
up at next CLI startup (CLI scans `/tmp/sesshin-*.json` older than 1 hour
and unlinks them).

### 5.2 Hub crash and restart

The hub flushes a small JSON checkpoint to
`~/.cache/sesshin/sessions.json` on every state transition (debounced
100 ms). On startup:

1. Read checkpoint, restore session registry in-memory.
2. For each session: send `process.kill(pid, 0)` to verify the CLI is
   alive.
3. Sessions whose CLI is gone → marked `interrupted`, no summarizer
   call, broadcast `session.removed` to clients on connect.
4. Sessions whose CLI is alive → CLI's heartbeat (every 10 s) confirms
   they're still tracked; the hub tells the CLI on next heartbeat
   "you are session X, here is the current cursor for your
   session-file-tail" so the file observer resumes from the right
   place.

Browser-side WS connections are torn down by the hub crash; SPA
reconnects with backoff and re-subscribes with `since:<lastEventId>` so
missed events replay.

### 5.3 Hook handler failures (critical: must never block claude)

The hook handler binary lives by three rules (Section 3.4). If the hub
is unreachable: the hook event is silently dropped from the hook path.
session-file-tail catches the same event (with some lag); hub state
stays consistent. The hub logs a warning if it sees session-file-tail
filling many gaps from missing hook events.

### 5.4 Session-file-tail failures

| Failure | Behavior |
|---|---|
| File does not exist at session start | Tail polls every 200 ms for up to 10 s, then watches the parent dir for the file's creation. claude usually creates it within 1-2 s of first user message. |
| File rotates / disappears mid-session | Re-resolve via session metadata; if not findable, downgrade to "hooks only" for that session and emit a warning. |
| Individual line fails to parse | Drop that line, log a debug entry, continue from next newline. |
| Permission denied | Surface as an attention event; downgrade to hooks-only for that session. |

### 5.5 Summarizer failures

```
Stop event → Mode B′ attempt:
  ├── 200 OK → broadcast session.summary, done.
  ├── 401/403 → assume Anthropic header drift. Disable Mode B′ for this
  │   session for the remainder of its life. Fall through to Mode B.
  │   Log once with full request/response (sans token) for diagnosis.
  ├── 429 → honor Retry-After header if present. If retry succeeds, done.
  │   If retry also 429s, fall through to Mode B.
  ├── 5xx or network error → retry once with 500 ms jitter. Then Mode B.
  └── Token expired AND refresh failed → mark session as needing re-auth,
      emit attention event, fall through to Mode B for this call.

Mode B subprocess attempt:
  ├── Exit 0 with parseable JSON → broadcast.
  ├── Exit non-zero or unparseable → fall through to heuristic.
  └── Spawn fails (claude binary missing) → fall through to heuristic.

Heuristic summary (v1 implements as the last-resort path, ~30 LOC):
  - oneLine = last non-empty PTY line (ANSI-stripped)
  - bullets = previous 4 non-empty lines
  - needsDecision = false (we don't know without a model)
  - emit + emit a session.attention severity:warning reason:"summarizer-failed"
```

After three consecutive failures within 10 minutes for a session,
summarization is disabled for that session entirely; an attention event
prompts the user to investigate.

### 5.6 WS protocol failures

| Failure | Behavior |
|---|---|
| Client never sends `client.identify` within 5 s of connect | Hub closes with `1002 protocol error`. |
| Client sends malformed JSON / wrong-type field | Hub responds with `server.error { code:"bad-frame" }` and closes. |
| Client subscribes to capability not declared | Hub silently drops the subscription request; clients may re-declare without reconnecting. |
| Client never responds to ping | Hub closes after 10 s of no pong. |
| Client buffer full | Hub stops sending to that client until `bufferedAmount` drops below threshold. Drop counter logged after 100 drops. |

### 5.7 Input arbitration failures (v1, simple form)

| Situation | Behavior |
|---|---|
| Remote input received while session is `running` | `server.error { code:"input-rejected", reason:"running" }`. No queue. |
| Remote input received but CLI is gone | `server.error { code:"input-rejected", reason:"session-offline" }`. |
| PTY write fails (CLI process dying) | CLI tells hub via heartbeat-error or socket close. Subsequent inputs to that session reject with `session-offline`. |

Queueing, priorities, "wait for awaiting-input" mode — all deferred.

---

## 6. Testing

### 6.1 Layer 1 — unit tests (vitest, every save)

Pure-logic modules with no I/O. Target >80% line coverage.

| Module | Coverage |
|---|---|
| `@sesshin/shared` zod schemas | Round-trip validation, malformed rejection. |
| `@sesshin/shared` crypto | Encrypt/decrypt roundtrip, key determinism, tamper detection. |
| `@sesshin/hub` state machine | Every documented hook → state transition. Heuristic for "Stop with question" (fake summary input). Stall watchdog (fake clock). |
| `@sesshin/hub` event normalization (`agents/claude/`) | Hook event JSON → normalized event. JSONL line → normalized event. Dedup key generation. |
| `@sesshin/hub` summarizer prompt assembly | (prev summary, new events, budget) → assembled input. Truncation rules. User-prompt and final-output retention invariants. |
| `@sesshin/hub` action → PTY-input mapping | Each action enum value maps to expected bytes. Unknown action returns null. |
| `@sesshin/hub` input arbiter | State-vs-source matrix from `docs/state-machine.md`. |
| `@sesshin/cli` settings tempfile generator | (sessionId, hub URL, hook handler path) → expected JSON. Tempfile-cleanup-on-exit handler tested with fake exit. |
| `@sesshin/hook-handler` | stdin JSON → POST body. Timeout enforcement (slow fake server, must exit by 250 ms). Always-exit-0 invariant via injected throws. |
| `@sesshin/debug-web` components | happy-dom: session card renders state badge, summary card; action buttons fire correct WS messages. |

### 6.2 Layer 2 — hub integration tests (vitest, in-process)

Hub started in-process. Real WS server, real REST, ephemeral ports.
Mocked at three boundaries: `msw` for Anthropic API, direct hook
POSTs to `/hooks` (no real claude), tempdir JSONL writes for
session-file-tail.

Scenarios:

1. Happy turn: register → UserPromptSubmit hook → PostToolUse → Stop
   → assert summary on a subscribed WS client within X ms.
2. Hook + file dedup: same turn arrives via both paths. Assert one
   broadcast event with the richer payload.
3. Mode B′ 401: hub disables B′ for the session, falls through to
   Mode B (mocked subprocess returning a fixed string).
4. Reconnect with `since`: client receives N events, disconnects,
   reconnects, asserts only post-cutoff events arrive.
5. Capability gating: `m5stick`-kind client without `raw` does not
   receive `session.raw`; concurrent `debug-web` does.
6. Token refresh under load: cred expiry in 30 s, three Stop hooks in
   rapid succession, assert exactly one refresh call goes out.
7. Hub restart mid-session: hub crashes after Stop hook acknowledged,
   restart picks up checkpoint, broadcasts session.list correctly.
8. Input arbitration: action sent during `running` rejected; same
   action during `idle` accepted and forwarded.

### 6.3 Layer 3 — one end-to-end test with stub-claude

A 50-LOC fake `claude` binary that:

- Reads `--settings` to find the hook handler path
- On stdin "make tests green", invokes hook handler with a recorded
  UserPromptSubmit event
- Writes to its session JSONL like real claude does
- Sleeps 2 s, invokes hook handler with PreToolUse / PostToolUse / Stop
- Reads stdin for "y" or "n" (simulating awaiting-confirmation case)

The test:

1. Starts real hub and CLI binaries with PATH putting stub-claude first.
2. Drives a synthetic conversation through stdin.
3. Connects a WS client, asserts complete event timeline.
4. Sends `input.action: approve` from WS, asserts stub-claude saw "y".

Catches process-boundary issues (env var propagation, settings
tempfile actually being read, hook handler invokable, PTY actually
delivering input).

### 6.4 Layer 4 — prototype scripts, manual

`prototypes/mode-b-prime.mjs`, `mode-c-prime.mjs`, `mode-g-prime.mjs`
stay manual diagnostic tools. NOT in CI: live API calls, burn quota,
require developer login. Re-run when verifying response shapes haven't
drifted. `prototypes/README.md` documents the when/how.

### 6.5 Out of scope for v1 testing

- Performance / load testing (defer until second adapter exists).
- Cross-platform CI; v1 is Linux + macOS only, Windows manual at most.
- Real claude in CI (too expensive and flaky; stub-claude substitutes).
- Adversarial WS security tests (defer until non-localhost binding).

### 6.6 Must-pass before merging the slice

- Layer 1 above 80% coverage on logic modules.
- All 8 Layer 2 scenarios green.
- Layer 3 e2e green on Linux + macOS.
- Settings-merge verification gate (Section 4.1 step 6 / Section 7
  below) has been run against the developer's actual claude install
  and the result documented in `docs/validation-log.md` Section 12.

---

## 7. Open verification gates (must complete before scaffolding)

These are the empirical questions the design depends on but hasn't yet
exercised. Each must be answered and the answer documented in
`docs/validation-log.md` before the corresponding code is written.

1. **Hooks merge across `--settings` layers** (per Section 4.1 step 6).
   Test: define a Stop hook in `~/.claude/settings.json`, run
   `claude --settings /tmp/test.json -p "say hi"` with a different
   Stop hook in the temp file, assert both fire. If they don't, the
   CLI uses the merged-file fallback path.

2. **Claude session JSONL location and format** (per Section 4.1 step 4
   and Section 3.2 observers). Confirm the actual path computation
   (encoding of cwd, where `<session-id>.jsonl` lives), the line
   format (turnId field name, whether `tool_use_id` is consistent),
   and that the file is append-only in practice.

3. **Hook event JSON shape per event type.** Each of `SessionStart`,
   `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`,
   `StopFailure`, `SessionEnd` has a documented shape; confirm by
   `console.error >&2 jq`-style inspection during a real claude
   session.

4. **PTY input injection while claude is at a prompt** works as
   expected. Specifically: writing "y\n" to claude's stdin while
   claude is awaiting confirmation should be indistinguishable from
   the user typing it.

If any gate fails, the design returns here for adjustment before
implementation continues.

---

## 8. Out of scope for this slice (deferred to later slices)

- Codex (Mode C′) and Gemini (Mode G′) agent adapters.
- Telegram bot adapter (will be its own slice; protocol is ready).
- M5StickC firmware client (its own slice).
- LAN binding, Tailscale networking, Cloudflare Tunnel.
- Token-based auth on WS for non-localhost.
- Stall detection / "still going" summaries.
- Input queueing and multi-source priority arbitration.
- Persistent metrics / spend tracking across sessions.
- Per-project sesshin config files (TOML).
- Sandbox host fallback for Anthropic API outages.
- Real-API canary in CI.
- The full Section 9 of `docs/state-machine.md` notification policy
  (M5Stick beep / Telegram message / etc.) — debug-web has no
  notifications equivalent in v1.

---

## 9. Pointers to other docs

- `docs/architecture.md` — long-form architecture context, security
  model, comparison with itwillsync.
- `docs/protocol.md` — full WS, hook event, REST schemas. The WS
  section is what `@sesshin/shared` types implement.
- `docs/state-machine.md` — full state machine including substate,
  stall detection, notification policy. v1 implements the primary
  states + transitions; some substate fields and the notification
  policy land later.
- `docs/summarizer.md` — full mode hierarchy across all three agents.
  v1 implements Mode B′ + Mode B + heuristic for Claude only.
- `docs/validation-log.md` — empirical record. v1 adds a Section 12
  for settings-merge verification, JSONL format confirmation, hook
  shape capture, and PTY-injection sanity check.
- `prototypes/mode-b-prime.mjs` — the working reference implementation
  of Mode B′. The hub's summarizer/mode-b-prime.ts will be a
  TypeScript adaptation of this script.
