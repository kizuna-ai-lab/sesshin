# Architecture

## Overview

```
                          User's laptop
   ┌──────────────────────────────────────────────────────────────────┐
   │                                                                  │
   │   ┌─────────────────────┐      ┌──────────────────────────────┐  │
   │   │   sesshin-cli       │      │      sesshin-hub (daemon)    │  │
   │   │   (per session)     │      │                              │  │
   │   │                     │      │   internal REST (loopback)   │  │
   │   │   PTY wraps:        │ ───► │     /api/sessions            │  │
   │   │     claude          │      │     /api/sessions/:id        │  │
   │   │     codex           │      │     /hooks                   │  │
   │   │                     │      │                              │  │
   │   │   user's terminal   │      │   event bus + state machine  │  │
   │   │   I/O is preserved  │      │   summarizer subprocess      │  │
   │   │   transparently     │      │   input arbiter              │  │
   │   │                     │      │                              │  │
   │   │   hook handler      │ ───► │   Sesshin WS server          │  │
   │   │   POSTs events      │      │   (LAN / Tailscale /         │  │
   │   │                     │      │    Cloudflare Tunnel)        │  │
   │   └─────────────────────┘      └──────────────┬───────────────┘  │
   │                                               │                  │
   └───────────────────────────────────────────────┼──────────────────┘
                                                   │
            ┌──────────────┬───────────────────────┼──────────────┐
            ▼              ▼                       ▼              ▼
       debug-web      telegram-bot           m5stick fw       future:
       (hidden)       adapter                 (WiFi+WS)       watch, mobile
```

## Components

### sesshin-cli (per-session wrapper)

Spawned by the user. Examples:

```
sesshin claude
sesshin codex
sesshin gemini
```

Responsibilities:

- Spawn the agent CLI inside a PTY using `node-pty`.
- Install per-session hook configuration before the agent process starts so
  that hook events route back to sesshin-hub via a localhost HTTP endpoint.
  The hook configuration is scoped to this invocation only and does not
  pollute the user's global agent settings. For Gemini this means writing
  a per-invocation `settings.json`; for Claude Code, the equivalent in
  Claude's hook config; for Codex, an inline `[hooks]` table or
  `hooks.json`. The handler binary is the same in all cases.
- Set the `SESSHIN_SESSION_ID` environment variable so the hook handler can
  attribute events to the right session.
- Pipe the user's local terminal I/O to the PTY transparently. The local CLI
  experience is unchanged. No prompt redraws, no resize fights with remote
  clients.
- Capture raw PTY output and forward it to the hub on the `raw` channel
  (debug only; not consumed by lightweight clients).
- Register with the hub via internal REST at startup. Send a heartbeat every
  10 seconds. Unregister cleanly at shutdown.

### sesshin-hub (daemon)

Singleton per-machine background process. Auto-spawned by the first
`sesshin-cli` invocation; auto-shuts-down when no sessions remain (after a
grace period). Listens on:

- Internal REST, loopback only. CLI registration, heartbeats, hook ingest,
  raw PTY ingest.
- Sesshin WS server. All external client traffic. Bind address depends on
  network mode (loopback / LAN / tailnet / tunnel-only).

Owns:

- Session registry (multi-session). Persisted to disk so a restarted hub can
  recover known-alive sessions.
- Event bus. Hook events, raw PTY chunks, internal control events.
- State machine, one per session. See `docs/state-machine.md`.
- Summarizer worker. See `docs/summarizer.md`.
- Input arbiter. Resolves multi-source input (laptop typing vs remote
  command) according to priority and current state.

### sesshin-hook-handler

A small binary or shell script that Claude Code, Codex, or Gemini CLI
invokes when a hook event fires. Reads the JSON event from stdin,
augments it with `agent` and `sessionId`, normalizes the event name to
Sesshin's shared vocabulary (see `docs/state-machine.md`), and POSTs it
to the hub's internal REST. The same handler works across all three
agents; the per-agent differences are confined to the event-name
normalization table.

The handler is observe-only in v1. It exits 0 with empty stdout for
Claude/Codex and an empty JSON object for Gemini (which requires a JSON
output), so it cannot block, modify, or otherwise interfere with the
agent. (This is a deliberate constraint; later versions may opt into
hook-mediated control.)

### sesshin-summarizer

A component inside the hub. On a `Stop` hook, it spawns the user's agent CLI
in print mode (e.g. `claude -p`) with a constrained prompt and a fast model.
The output is parsed into a `Summary` object and broadcast over the WS server.
See `docs/summarizer.md`.

### Adapters

Each adapter is a separate process that connects to the hub WS server using
the Sesshin protocol and bridges to an external system.

- **debug-web**: serves a small SPA on a known port. Renders all events,
  summaries, and the raw stream. Development inspection tool, not the
  product.
- **telegram-bot**: subscribes to one or more sessions. Renders summaries as
  Telegram messages, one Telegram thread per session. Parses replies as
  `input.text` or `input.action`. Pairs with a hub via a one-time bind code.
- **m5stick-firmware**: ESP32 firmware that connects to the hub over WiFi.
  Renders state and one-line summary on the small LCD. Sends quick-action
  input via buttons. Sends voice-transcribed input via on-device STT.

Adapters are decoupled from the hub: removing or replacing one is a
process-level operation, not a protocol change.

## Data flow: a typical turn

1. User on laptop types a prompt into Claude Code.
2. Claude Code's `UserPromptSubmit` hook fires. The handler POSTs to the hub.
3. Hub records the event, transitions session state to `running`, broadcasts
   `session.event` and `session.state`.
4. Claude Code emits `PreToolUse` and `PostToolUse` hooks throughout the turn.
   Hub records them and may update substate (e.g. `currentTool`).
5. Claude Code's `Stop` hook fires. Hub flips state to `idle` or
   `awaiting-input` (see state machine for the heuristic) and triggers the
   summarizer.
6. Summarizer spawns `claude -p` with a tightly scoped prompt that includes
   the previous summary and the new events. Receives a structured summary.
   Broadcasts `session.summary`.
7. M5Stick shows the one-line. Telegram bot posts the summary in the session's
   thread. Debug web shows everything including the raw stream.
8. User on the M5Stick taps a button mapped to "approve". The firmware sends
   `input.action` to the hub.
9. Hub's input arbiter checks state (is it `awaiting-confirmation`? yes),
   checks priority (laptop is idle, no conflict), maps the action to the
   right input string for Claude Code, and writes it to the PTY.
10. Claude Code receives input as if typed locally; the turn continues.

## Network topology

| Mode | Reachability | Notes |
|------|--------------|-------|
| LAN | Devices on same WiFi (M5Stick at home, debug web on phone) | Default for v1 prototyping |
| Tailscale | All tailnet nodes from anywhere | Recommended for personal use across networks |
| Cloudflare Tunnel | Public Internet | Required for IM bot webhooks; supports WebSocket on all plans but Free/Pro impose a 100 s idle timeout, mitigated by 30 s ping/pong heartbeat |

The hub's WS server can serve all three modes simultaneously by binding to the
appropriate interfaces. Per-session tokens authenticate access regardless of
transport; encryption is also per-session (NaCl secretbox).

## Multi-session model

A single hub manages many concurrent sessions. Each session has:

- Stable session ID, assigned at registration.
- Agent type (`claude-code`, `codex`, ...).
- Working directory.
- Display name (defaults to agent + cwd basename).
- Independent state machine.
- Independent subscription routing. Clients subscribe per session.

Clients render sessions as independent units (Telegram threads, M5Stick
screens, dashboard cards). They are never blended.

A user running two `claude` instances and one `codex` simultaneously appears in
clients as three distinct, addressable session blocks.

## Security model

- Each session has a 64-character random token (NaCl-friendly key material).
- The Sesshin WS protocol is end-to-end encrypted with NaCl secretbox using a
  key derived from the session token via the same construction as itwillsync's
  `deriveEncryptionKey`. Reimplemented in `@sesshin/shared/crypto` rather than
  imported, to keep the dependency surface clean and the codebase
  self-contained.
- Internal REST is bound to loopback and unauthenticated within the machine
  boundary. (Anyone with shell access on the host already has total control.)
- Adapters obtain the session token via:
  - QR pairing for the debug web client (token in URL).
  - One-time bind code for the Telegram bot. The user runs a hub-side
    `sesshin pair telegram` command which prints a code; the user sends that
    code to the bot once.
  - Direct provisioning for M5Stick (configured via captive portal at first
    boot).
- The hub reads the user's local agent OAuth tokens (Claude:
  `~/.claude/.credentials.json` or OS keyring; Codex:
  `~/.codex/auth.json`) when generating summaries via the direct-API
  path (Modes B′ / C′ in `docs/summarizer.md`). Tokens are kept in
  memory only after read; refreshed tokens are written back atomically
  with original file mode preserved so the agent CLI itself stays in
  sync. Credentials never leave the local machine.
- The summary fallback path (Modes B / C) spawns the agent CLI as a
  subprocess and inherits credentials from the user's environment /
  config files, without the hub reading them directly. Users who prefer
  this can disable the direct-API path entirely.

## Comparison to itwillsync

| Concern | itwillsync | Sesshin |
|---------|------------|---------|
| Client primary | Browser xterm.js terminal | M5StickC, IM, dedicated devices |
| Data primary | Raw PTY bytes streamed verbatim | Semantic events plus AI-produced summaries |
| PTY role | Sole source of truth | Fallback / debug only |
| Agent integration | Generic; anything that runs in a terminal | Agent-aware via hooks (Claude Code, Codex) |
| Reconnection | Scrollback delta sync (byte-level, `seq` counter) | State plus summary replay (event-level, `eventId`) |
| Out-of-LAN | Tailscale, Cloudflare Tunnel | Same; Cloudflare Tunnel is required for IM webhooks |
| Multi-session | Yes; hub on fixed ports 7962 / 7963 | Yes; analogous two-port hub layout |
| Encryption | NaCl secretbox keyed by per-session token | Same scheme |

The two-port hub layout (one internal-only REST port, one external WS port) is
deliberately reused from itwillsync. The topology is sound, the failure modes
are well-understood, and there is no value in deviating from it.

## Build sequence (proposed)

1. Hub skeleton: registry, internal REST, hook ingest, in-memory event bus.
2. CLI skeleton: PTY wrap, hook config injection, REST registration.
3. Hook handler: minimal stdin-to-POST adapter.
4. State machine wired to hook events. State broadcasts only.
5. Summarizer subprocess. Validation against real `claude -p` first.
6. Sesshin WS server. Capability negotiation. Subscription. Summary
   broadcast.
7. Debug web client. Useful in itself for development.
8. Telegram adapter.
9. Quick-action input mapping. Input arbiter.
10. M5Stick firmware against the same WS protocol.

Steps 1 to 6 are the load-bearing part. Steps 7 onward iterate against a
working hub.

## v1.5 — Ambient remote control

The v1.5 design baseline lives in
`docs/superpowers/specs/2026-05-03-ambient-remote-control-v1.5-design.md`
and introduced mode-aware approval, the unified `session.prompt-request`
wire shape (claude's `PermissionRequest` shape forwarded verbatim), and
the per-tool interaction handler registry. v1.6 (the cleanup that
produced this revision of the doc) consolidated approval onto a single
path; what follows describes the post-cleanup architecture.

Key components:

- **Single approval path** — Claude's `PermissionRequest` HTTP hook is
  the only approval gate. Claude POSTs to `/permission/:sessionId` on
  the hub's internal REST; the hub dispatches to the per-tool handler
  registry, awaits a remote decision over the WS protocol, and replies
  with the `{behavior: 'allow'|'deny', ...}` shape Claude expects.
  Sesshin no longer maintains its own parallel rule list or a
  `PreToolUse` adapter — claude's own permission system (settings.json
  plus session-scope rules) determines whether a tool fires
  `PermissionRequest` at all.

- **Subagent-aware fallback** — `PermissionRequest` payloads carry
  `agent_id` when the call originates inside a Task subagent.
  Subagents run headless in Claude with no TUI fallback, so the hub
  fail-closes with a diagnostic deny on dispatch error or
  null-passthrough. Main-thread calls fail-open with HTTP 204 so
  Claude's TUI can take over. The same logic applies when no remote
  approver is wired at all.

- **Parent vs child Claude session** — sesshin tracks both its own
  process-lifetime session id (parent) and Claude's own `session_id`
  (child, which changes on `/clear`, `--resume`, and startup but stays
  stable on `/compact`). State ownership and boundary handling live in
  `docs/state-machine.md` ("Parent vs child Claude session"); pending
  approvals are tied to the child id and are cancelled on boundary
  transitions.

- **Mode tracking** — `Substate.permissionMode` is sourced
  authoritatively from JSONL `permission-mode` records. The CLI seeds
  an initial mode from `~/.claude/settings.json` and the
  `--permission-mode` flag.

- **Per-tool handler registry**
  (`packages/hub/src/agents/claude/tool-handlers/`) — Bash, FileEdit,
  WebFetch, AskUserQuestion, ExitPlanMode, and a catch-all handler each
  translate a tool's `tool_input` into a wire-uniform
  `{questions, options}` shape and translate user answers back into a
  hook decision with optional `updatedInput` and `updatedPermissions`.
  The `updatedPermissions` field carries `addRules` and `setMode`
  entries that Claude persists into its own session-scope settings, so
  trust ("always allow this command") flows through Claude's rule
  system rather than a sesshin-local list.

- **Subscribed-client gating** — the hub tracks per-session count of
  `actions`-capable clients. When zero such clients are subscribed, the
  WS adapter returns `null` from `onPermissionRequestApproval`, the
  REST handler replies 204, and Claude's TUI handles approval natively.
  Last-disconnect releases any pending approvals the same way so the
  TUI can take over.

- **REST diagnostics + CLI subcommands** — `/api/diagnostics`,
  `/api/sessions/:id/{clients,history,gate,pin,quiet}` and matching
  `sesshin status / clients / history / gate / pin / quiet`
  subcommands.

- **Slash commands** — bundled `.md` files installed via
  `sesshin commands install`.
