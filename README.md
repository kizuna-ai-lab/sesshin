# Sesshin

Ambient awareness and remote control for AI/CLI coding sessions.

Leave your laptop without leaving the session. Sesshin lets a long-running AI
agent (Claude Code, Codex, ...) keep working at your desk while you receive
condensed status updates and send brief instructions from a small dedicated
device, an instant messenger, or any other client that speaks the Sesshin
protocol.

## Status

**v1.5 milestone complete (May 2026).** Mode-aware ambient remote control,
unified `session.prompt-request` wire shape, per-tool handler registry, REST
diagnostics + CLI subcommands, bundled slash commands. See `docs/superpowers/specs/`
for the design history.

## What Sesshin is

- A bridge that lets you observe and steer a long-running AI/CLI session from
  devices other than the laptop running it.
- An AI-driven summarization layer that condenses verbose agent output into
  short, glanceable status updates suitable for small screens, instant
  messengers, and dedicated devices.
- A pluggable adapter system. Instant messenger bots (Telegram first),
  small-screen firmware (M5StickC family), and a debug web client all speak the
  same WebSocket protocol.

## What Sesshin is not

- Not a remote terminal in the xterm.js sense. The laptop session is the only
  place that displays a full terminal. A debug web client may exist but is
  hidden by default and is not the design target.
- Not a credential relay or multi-tenant service. For summary generation,
  Sesshin reads the OAuth tokens that each agent CLI itself stores
  locally — `~/.claude/.credentials.json` for Claude Code,
  `~/.codex/auth.json` for Codex, `~/.config/.gemini/oauth_creds.json`
  for Gemini CLI — and calls each agent's backend API directly on the
  same machine where the user is already running the agent. Credentials
  never leave that machine. The mechanism is the same OAuth flow each
  official CLI uses; the ToS posture is documented openly in
  [`docs/summarizer.md`](docs/summarizer.md). Users who prefer the
  officially supported path can configure Sesshin to fall back to a
  subprocess (`claude -p` / `codex exec` / `gemini -p`) for every
  summary, at the cost of latency and weekly subscription quota.
- Not a multi-tenant SaaS. The hub daemon runs on the user's own machine.
  Out-of-LAN reachability for IM bots and dedicated devices is achieved via
  Tailscale or Cloudflare Tunnel, not via a Sesshin-operated server. (A
  managed relay tier may be offered later as an opt-in convenience.)

## Origin

The project began with a narrower goal: enable a user to leave the laptop while
a long-running AI task is in progress, without being pulled into the phone's
other distractions. A dedicated low-distraction device, for example an
M5StickC Plus2 worn on a lanyard, should be enough to know "the agent is still
working", "it needs my approval", "it is done". Wider device support
(instant messengers, future watches and phones) follows from this seed but
should not compromise the original property: a quiet, focused channel from the
agent to the user.

## Key technical choices

- Hooks, not pseudo-terminal scraping, are the primary semantic event
  source. Claude Code, Codex, and Gemini CLI all expose hook lifecycles
  (`SessionStart` / `Stop` / `PreToolUse` / `PostToolUse` / etc., with
  Gemini using the renamed `BeforeAgent` / `AfterAgent` / `BeforeTool` /
  `AfterTool`). A single hook handler with a per-agent name-mapping
  table services all three agents.
- Summaries are produced via direct authenticated calls to each agent's
  backend (Anthropic Messages API for Claude, ChatGPT Codex backend for
  Codex, Google Cloud Code Assist API for Gemini), using OAuth tokens
  the agent CLIs already store locally. The hub never spawns an
  unconstrained agent subprocess for summarization on the hot path
  (subprocess mode is the fallback only).
- The client-facing WebSocket protocol carries semantic events and summaries,
  not raw terminal bytes. Every adapter speaks the same protocol; they differ
  only in what subset of capability they declare.
- Raw PTY output is captured but only published to clients that explicitly
  subscribe to a `raw` capability. Debug only.

## Acknowledgments and prior art

This project was inspired by [itwillsync](https://github.com/shrijayan/itwillsync),
which solves the adjacent problem of mirroring a terminal to a phone over local
network. Sesshin shares some structural ideas with itwillsync:

- A per-session bridge process plus a singleton hub daemon.
- End-to-end encryption keyed by per-session tokens (NaCl secretbox).
- A multi-session registry and discovery via a localhost REST API.
- Network exposure via Tailscale and Cloudflare Tunnel.

Sesshin departs from itwillsync in that:

- The primary signal is hook-driven semantic events with AI-produced summaries,
  not raw terminal bytes.
- The intended client is a low-power dedicated device or an IM bot, not a
  browser running xterm.js.
- The protocol is not designed to drive a terminal emulator.

See [`docs/architecture.md`](docs/architecture.md) for a side-by-side
comparison.

`claude-relay-service` and `Clove` are sometimes mistakenly grouped with
Sesshin. They solve a different problem: relaying a Claude account's OAuth
token through a self-hosted API gateway. Sesshin does not do this and does not
need to, because it relies on the user's own agent CLI being installed and
logged in on the same machine. See
[`docs/summarizer.md`](docs/summarizer.md) for how summaries are produced
without handling credentials.

## High-level architecture

```
                       ┌───────────────────────────────┐
                       │         User's laptop         │
                       │                               │
   sesshin claude  →   │   sesshin-cli (PTY wrap)      │
   sesshin codex   →   │     │                         │
                       │     │ hooks                   │
                       │     ▼                         │
                       │   sesshin-hub (daemon)        │
                       │     • event bus               │
                       │     • state machine           │
                       │     • summarizer subprocess   │
                       │     • input arbiter           │
                       │     • Sesshin WS server       │
                       └────────────┬──────────────────┘
                                    │ WS
              ┌─────────────┬───────┴──────┬──────────────┐
              ▼             ▼              ▼              ▼
         debug-web     telegram-bot    m5stick fw    (line / slack)
```

## Documentation

- [Architecture](docs/architecture.md) — components, data flow, network topology
- [Protocol](docs/protocol.md) — WS protocol, hook event format, internal REST
- [State machine](docs/state-machine.md) — session states and transitions
- [Summarizer](docs/summarizer.md) — trigger, subprocess approach, diff strategy

## Run (developer preview)

Requires Node 22+, pnpm 9+, a working `claude` binary on PATH, and an
active Claude.ai login (`claude /login`).

```bash
pnpm install
pnpm build
pnpm e2e            # offline e2e using stub-claude (no API spend)

# Real run:
packages/cli/bin/sesshin claude
# Then open http://127.0.0.1:9662 in a browser.
```

## Settings-merge fallback

In rare cases (verification gate 1 in `docs/validation-log.md` revealed
this is necessary on your install), set:

```
export SESSHIN_MERGE_USER_HOOKS=1
```

before running `sesshin claude`. The CLI will read your existing
`~/.claude/settings.json` hooks and compose them with Sesshin's into the
per-session temp file. User-visible behavior is unchanged.

## Permission gating

Sesshin observes Claude Code's `PreToolUse` hook and is mode-aware. In
`auto`, `acceptEdits`, `bypassPermissions`, `dontAsk`, or `plan` mode
sesshin is transparent: no remote prompt is raised and the tool call
proceeds under claude's own policy. In `default` mode, write-class tools
(`Bash`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `PowerShell`,
`WebFetch`) trigger a `session.prompt-request` that the web user can
answer.

If no client is currently subscribed for that session, sesshin steps
aside and lets claude's TUI prompt the laptop user as normal. So the
mental model is: **open the web UI to take over, close it to give
control back to the laptop.** The session also tracks claude's
permission rules and any session-allow rules added via `/sesshin-trust`,
short-circuiting the gate when an allow rule already covers the call.

Environment variables:

- `SESSHIN_APPROVAL_TIMEOUT_MS` — hub-side timeout before a pending
  approval falls back to claude's TUI prompt. Default 60000.

## Slash commands

Sesshin ships a set of slash commands that surface session diagnostics
and per-session controls inside Claude Code:

| Command | Purpose |
|---|---|
| `/sesshin-status`  | Current mode, gate, pending approvals, clients |
| `/sesshin-clients` | List connected web/IM/device adapters |
| `/sesshin-history` | Last N remotely resolved decisions |
| `/sesshin-trust`   | Add a session-allow rule, e.g. `Bash(git log:*)` |
| `/sesshin-gate`    | Override gate policy for this session |
| `/sesshin-pin`     | Sticky note shown on remote clients |
| `/sesshin-quiet`   | Suspend remote notifications for a duration |

Install them once with:

```bash
sesshin commands install
```

This copies the bundled markdown files to `~/.claude/commands/`. The
install is opt-in and one-time; nothing is touched until you run it.
We probed the `--settings`-delivered plugin path empirically and it did
not work in our environment, so the manual install is the supported
path for v1.5.

## Log file

The hub writes to `~/.cache/sesshin/hub.log`. Tail it for diagnostics.

## License

MIT (placeholder; to be confirmed before first release).
