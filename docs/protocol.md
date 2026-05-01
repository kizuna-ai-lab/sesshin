# Protocol

Three protocols define Sesshin's surface area:

1. **Sesshin WS Protocol** — between hub and clients (debug web, Telegram bot,
   M5Stick firmware, future adapters).
2. **Hook Event Protocol** — between agent CLI hooks and hub.
3. **Internal REST** — between sesshin-cli and sesshin-hub.

Each protocol carries an explicit version. v1 implements WS protocol v1, hook
event protocol v1, internal REST v1. Backwards-incompatible changes bump the
major version; the hub may serve multiple major versions simultaneously during
a transition.

---

## 1. Sesshin WS Protocol v1

### Connection

- Endpoint: `wss://<host>:<port>/v1/ws?token=<token>`
- Token validates via constant-time comparison.
- After token check, the connection is end-to-end encrypted with NaCl
  secretbox; the symmetric key is derived from the token (see `architecture.md`
  → Security model).
- Frames are JSON encoded then encrypted. Maximum frame size: 64 KiB. Frames
  larger than the limit are rejected and the connection is closed.

There are two flavors of token:

- **Session token**: scopes the connection to one session. Suitable for
  M5Stick paired to a single session.
- **Master token**: scopes the connection to the hub. The client may
  subscribe to any session known to the hub. Suitable for the Telegram bot
  and the debug web client.

### Capability negotiation

The first message after connect MUST be `client.identify`:

```json
{
  "type": "client.identify",
  "protocol": 1,
  "client": {
    "kind": "debug-web",
    "version": "0.1.0",
    "capabilities": ["summary", "events", "raw", "actions", "voice", "history"]
  }
}
```

Allowed `kind` values for v1:

- `debug-web`
- `telegram-adapter`
- `m5stick`
- `watch` (reserved)
- `mobile` (reserved)
- `other`

The hub responds with `server.hello`:

```json
{
  "type": "server.hello",
  "protocol": 1,
  "machine": "user-laptop",
  "supported": ["summary", "events", "raw", "actions", "voice", "history", "state", "attention"]
}
```

If the client declares a capability the hub does not support, the hub returns
`server.error` with `code: "unsupported-capability"` and closes the
connection.

Suggested default capability sets per client kind:

| Tier | Capabilities | Suitable clients |
|------|--------------|------------------|
| minimal | `summary`, `state`, `attention` | M5Stick, watch |
| standard | minimal + `events`, `actions` | Telegram, mobile |
| full | standard + `raw`, `history`, `voice` | Debug web |

A client cannot subscribe to a stream it did not declare in `capabilities`.
The hub silently drops messages it would otherwise have sent on a stream the
client cannot receive. This makes per-device tiering enforcement explicit.

### Subscription

```json
{
  "type": "subscribe",
  "sessions": ["session-id-1", "session-id-2"],
  "since": null
}
```

`sessions` may be the literal string `"all"` to subscribe to every current and
future session (only honored for master-token connections).

`since` is the last `eventId` seen by the client. If non-null the hub replays
events from that point. If null the hub emits a fresh `session.list` and
recent summaries only (no event replay).

```json
{ "type": "unsubscribe", "sessions": ["session-id-1"] }
```

### Downstream messages (hub → client)

| type | when | payload (key fields) |
|------|------|----------------------|
| `session.list` | on subscribe; on registry change | `sessions: SessionInfo[]` |
| `session.added` | new session registered | `session: SessionInfo` |
| `session.removed` | session ended | `sessionId` |
| `session.state` | state machine transition | `sessionId, state, substate` |
| `session.event` | semantic event from hook | `sessionId, eventId, kind, payload, source` |
| `session.summary` | summarizer produced output | `Summary` (see below) |
| `session.attention` | needs-user-now signal | `sessionId, severity, reason, summaryId?` |
| `session.raw` | raw PTY bytes (capability `raw`) | `sessionId, seq, data` |
| `session.history` | replay response | `events: Event[]` |
| `server.error` | protocol or auth error | `code, message` |
| `server.ping` | application-level ping (in addition to WS-level) | `nonce` |

`SessionInfo`:

```ts
type SessionInfo = {
  id: string
  name: string
  agent: "claude-code" | "codex" | "other"
  cwd: string
  pid: number
  startedAt: number      // unix ms
  state: SessionState
  substate: Substate
  lastSummaryId: string | null
}
```

`Summary`:

```ts
type Summary = {
  type: "session.summary"
  sessionId: string
  summaryId: string
  oneLine: string             // <= 100 chars
  bullets: string[]            // 0..5 items, each <= 80 chars
  needsDecision: boolean
  suggestedNext: string | null
  since: string | null         // previous summaryId
  generatedAt: number          // unix ms
  generatorModel: string
}
```

`session.event`:

```ts
type Event = {
  type: "session.event"
  sessionId: string
  eventId: string              // monotonic per session
  kind: "user-prompt" | "tool-call" | "tool-result" | "agent-output" | "error" | "stall"
  payload: object              // kind-specific
  source: "laptop" | "remote-adapter:<id>"
}
```

The `source` field always identifies where input originated, so clients can
render "you typed this on phone" vs "agent emitted this".

### Upstream messages (client → hub)

| type | purpose | payload |
|------|---------|---------|
| `client.identify` | first frame | (above) |
| `subscribe` | start receiving updates | (above) |
| `unsubscribe` | stop a subscription | `sessions` |
| `input.text` | free-form prompt | `sessionId, text` |
| `input.action` | quick action | `sessionId, action` |
| `input.voice` | voice-transcribed text | `sessionId, text, confidence` |
| `history.request` | request history page | `sessionId, before, limit` |
| `client.pong` | response to `server.ping` | `nonce` |

### Reserved actions

The set of actions any adapter can emit, mapped by the hub to a concrete
input string per agent:

`continue`, `stop`, `retry`, `fix`, `summarize`, `details`, `ignore`,
`snooze`, `approve`, `reject`

Action mappings live in the hub. Adapters do not need to know the mapping.
This means a Telegram bot's "Approve" button works identically against
Claude Code and Codex even though the underlying input strings differ.

### Heartbeat

- The WS server sends a WS-level ping every 30 seconds.
- The client must respond with pong within 10 seconds.
- Failure to pong terminates the connection.

This 30 s cadence is chosen to stay well under Cloudflare Tunnel's 100 s
idle timeout on Free and Pro plans.

In addition, the hub may send `server.ping` at the application layer when it
needs round-trip confirmation (e.g. before delivering an `attention` event
that should not be lost).

---

## 2. Hook Event Protocol v1

Claude Code, Codex, and Gemini CLI all invoke a hook by spawning the
configured command and writing a JSON event to stdin. Sesshin installs a
single handler binary as the hook target across all three agents. The
handler:

1. Reads stdin to EOF, parses JSON.
2. Adds `agent` field (`claude-code`, `codex`, or `gemini`), derived from
   environment variable `SESSHIN_AGENT`.
3. Adds `sessionId` from environment variable `SESSHIN_SESSION_ID`.
4. Maps the agent-native event name to Sesshin's normalized event
   vocabulary (see `docs/state-machine.md` for the mapping table). The
   `event` field carries the normalized name; the original name is
   retained at `raw.nativeEvent`.
5. POSTs to hub at `http://127.0.0.1:<internal_port>/hooks` with this
   payload:

```json
{
  "agent": "gemini",
  "sessionId": "abc123",
  "ts": 1730000000000,
  "event": "Stop",
  "raw": {
    "nativeEvent": "AfterAgent",
    /* original event JSON from agent, unmodified */
  }
}
```

Recognized normalized `event` values for v1:

- `SessionStart`
- `UserPromptSubmit`
- `PreToolUse`
- `PostToolUse`
- `Stop`
- `StopFailure`
- `SessionEnd`

Plus a passthrough kind for agent-specific events that don't map to the
normalized set (e.g. Gemini's `BeforeModel`, `AfterModel`,
`BeforeToolSelection`, `PreCompress`, `Notification`):

- `agent-internal` — `raw.nativeEvent` carries the original name; the hub
  does not transition state on these but does broadcast them as
  `session.event` so debug clients can see them.

6. Exits 0 with empty stdout (or with a JSON object on stdout when
   running under Gemini, since gemini-cli expects valid JSON output from
   hooks; the hub-side handler emits an empty `{}` when no decision is
   needed). Non-zero exits are reserved for future Sesshin-side
   enforcement; in v1 the handler is observe-only and never blocks the
   agent.

Field normalization across agents is the handler's responsibility for
event names; payload-level normalization (tool-name vocabularies, etc.)
is done in the hub. The handler always preserves `raw` verbatim.

---

## 3. Internal REST v1

Loopback only, unauthenticated within the machine boundary. The expectation is
that anyone with shell access on the host already has total control of the
session, so authenticating REST against itself adds no security but adds
operational pain.

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/sessions` | POST | CLI registers a new session at startup |
| `/api/sessions/:id` | DELETE | CLI unregisters at shutdown |
| `/api/sessions/:id/heartbeat` | POST | CLI keeps session alive (every 10 s) |
| `/api/sessions` | GET | Hub-internal: list current sessions |
| `/hooks` | POST | Hook handler ingest |
| `/api/sessions/:id/raw` | POST | CLI streams raw PTY chunks (chunked or framed JSON; capability `raw`) |
| `/api/sessions/:id/master-token` | GET | One-time retrieval of master token (for adapter pairing) |
| `/api/health` | GET | Hub health check |

### Session registration request

```json
POST /api/sessions
{
  "name": "claude (myproject)",
  "agent": "claude-code",
  "cwd": "/home/me/myproject",
  "pid": 12345,
  "token": "<64-char hex>"
}
```

Response:

```json
{ "id": "abc123", "registeredAt": 1730000000000 }
```

### Default ports

- Internal REST: `9663` (loopback only)
- Sesshin WS: `9662`

These mirror itwillsync's two-port choice (`7962` external, `7963`
internal) shifted into a different band to avoid collision when both tools
are installed on the same host.

---

## Versioning policy

- The `protocol` field in `client.identify` and `server.hello` is a single
  integer. Sesshin v1 uses `1`.
- Adding new message types or new optional fields is **not** a breaking
  change. Clients ignore unknown fields and unknown message types.
- Removing or changing the meaning of a message type or required field **is**
  a breaking change and bumps the major version.
- The hub MAY serve protocol v1 and v2 simultaneously by responding to the
  `protocol` field in `client.identify`. Clients negotiate up to the highest
  version they understand.
