# Statusline-driven rate-limit readout

**Date:** 2026-05-07
**Status:** Implemented (2026-05-07, PR #11)

## Problem

Sesshin currently has no way to surface the user's Anthropic Claude.ai 5-hour and 7-day rolling-window quota state to its clients. The data exists, but it is only ever delivered to Claude Code through HTTP response headers (`anthropic-ratelimit-unified-5h-utilization`, `…-5h-reset`, `…-7d-utilization`, `…-7d-reset`, `…-status`). Claude Code parses those headers into in-memory state in `services/claudeAiLimits.ts`. The state is **not** persisted anywhere on disk — JSONL transcripts contain only `usage` token counts, `~/.claude.json` only caches the overage-disabled reason, and there is no IPC, socket, or file an external process can read.

The single official surface where Claude Code re-emits the parsed state is the `statusLine` JSON it writes to its statusline command's stdin on each render:

```json
{
  "rate_limits": {
    "five_hour": { "used_percentage": 45.2, "resets_at": 1714867200 },
    "seven_day": { "used_percentage": 23.1, "resets_at": 1714953600 }
  },
  ... other fields ...
}
```

Sesshin already injects a temporary `--settings` file when wrapping Claude (`packages/cli/src/settings-tempfile.ts`, `settings-merge.ts`), so it is well-positioned to install its own statusline command, capture the JSON side-channel, and forward both the data and the original output. This design lays out that capture pipeline, its on-the-wire shape, and a glanceable readout in `debug-web`.

## Scope

**In:**

1. New thin relay binary `sesshin-statusline-relay`, shipped as a **second bin entry in `@sesshin/cli`** (not a new package), with a separate tsup entry so its bundle stays minimal (~3 KB target).
2. CLI changes to: (a) resolve the user's existing `statusLine.command` from the CC settings hierarchy at session-start, (b) inject our own `statusLine` into the temp settings file, and (c) export the resolved original via env var to the relay.
3. New hub REST endpoint `POST /reports/rate-limits` — a fire-and-forget intake mirroring `POST /hooks` (`packages/hook-handler/src/main.ts`).
4. Per-session in-memory store in the hub (`Map<sessionId, RateLimitsState>`), wired into the existing subscribe-replay broadcast path so newly connected clients see the last-known value immediately.
5. New WS broadcast type `session.rate-limits` with a Zod schema in `@sesshin/shared`.
6. New `RateLimitsPill` component in `debug-web`, rendered inline in the existing `SessionDetail` header row, plus a Zustand store slice and a WS-dispatch wiring.
7. A single env-var escape hatch `SESSHIN_DISABLE_STATUSLINE_RELAY=1` that suppresses statusline injection entirely.
8. Test coverage at the unit level for: relay edge cases, settings-resolution helper, settings-merge behavior, hub REST handler, WS broadcast/replay, and pill render-state matrix.

**Out (explicitly deferred):**

- **History / trend graphs.** The hub stores only the latest value; nothing is appended to disk.
- **Account-aggregated view across concurrent sessions.** Per-session storage is locked in; if two sessions on the same Anthropic account both run, both pills show roughly the same numbers. Acceptable for v1.
- **Active probe.** The hub does not initiate API calls of its own to refresh a stale value. Refresh happens only when CC re-renders the statusline (i.e. on agent steps / API responses).
- **Per-session-secret auth between relay and hub.** The relay → hub channel is loopback-only and unauthenticated, identical to the trust model `hook-handler` already uses. Hardening this is a cross-cutting concern that would also affect `hook-handler` and is therefore not in scope here.
- **End-to-end test against a live Claude Code instance.** Wired contracts and unit tests guard the data path; the actual statusline-handshake is verified once manually and then guarded by the unit suite.
- **Backwards-compatibility shim for users on raw API keys.** When `rate_limits` is absent from CC's stdin (the API-key case), the pill simply does not render. No alternate UX.

## Architectural fit

The pipeline mirrors a pattern already established by `hook-handler`: a tiny stdin-reading binary that POSTs to a hub REST endpoint, fire-and-forget, and exits. The hub then broadcasts a typed message over the existing WS server, and clients update their stores from a single dispatch site. Three deliberate symmetries with `hook-handler`:

- Same trust model: loopback only, no token, env-vars `SESSHIN_HUB_URL` and `SESSHIN_SESSION_ID` already injected by `packages/cli/src/claude.ts` when spawning Claude.
- Same fast-timeout philosophy: 250 ms POST timeout, errors swallowed (`hook-handler.ts`'s `FAST_TIMEOUT_MS`), so the wrapped statusline never blocks on hub latency.
- Same "broadcast → store → render" UI dispatch pipeline as `session.summary`, `session.config-changed`, etc.

The two **deliberate departures** from the `hook-handler` template are:

1. **Packaging.** `hook-handler` is its own workspace package; `sesshin-statusline-relay` lives inside `@sesshin/cli` as a second bin entry. Rationale: the existing CLI's full module graph (~34 KB compiled, with `node-pty` and `ws` at the top of the import tree) would slow every statusline render unacceptably, so sharing a process is impossible — but creating a separate package is also unnecessary overhead. A second `tsup` entry compiled from `packages/cli/src/statusline-relay/` produces an isolated bundle that imports only what it needs, without committing to a new package boundary.
2. **Wrap, don't shadow.** Unlike `hook-handler`, which is the only command of its kind, the user may already have a `statusLine` configured (e.g. `ccusage`, `ccstatusline`). Sesshin's injected file would otherwise silently shadow it. The relay therefore **runs the user's resolved original command as a subprocess**, pipes the same stdin into it, and forwards its stdout. The user's existing setup is preserved verbatim while we capture the side-channel.

The settings-resolution step happens **once per session**, in the parent CLI process, before the temp settings file is written. The relay does not re-read CC settings on every tick — it inherits the resolved command via env var, keeping per-render work bounded to (parse, POST, spawn, pipe).

## File-level change map

| Package / file | Change |
|---|---|
| `cli/package.json` | Add `"sesshin-statusline-relay": "bin/sesshin-statusline-relay"` to the `bin` map. |
| `cli/bin/sesshin-statusline-relay` (new) | 4-line shim: `#!/usr/bin/env node` + `await import('../dist/statusline-relay.js')`. Mirrors `bin/sesshin`. |
| `cli/tsup.config.ts` | Add second entry: `src/statusline-relay/index.ts` → `dist/statusline-relay.js`. |
| `cli/src/statusline-relay/index.ts` (new) | Entry point. Reads stdin, POSTs to hub, spawns wrapped command, forwards output, exits. |
| `cli/src/statusline-relay/relay.ts` (new) | Pure logic split out for testability: takes injected `fetch`, `spawn`, `stdout`, `stderr`, `env`, returns a number (exit code). |
| `cli/src/statusline-relay/relay.test.ts` (new) | Eight edge-case tests (one per row of the table in §"Edge cases"). |
| `cli/src/read-claude-settings.ts` | Add `resolveInheritedStatusLine(opts)` that walks the CC settings hierarchy, optionally excluding our injected temp-file path, and returns `{ command: string; padding?: number } | null`. Existing `readClaudeSettings` is reused. |
| `cli/src/read-claude-settings.test.ts` | Extend with three new cases: only user has `statusLine`; user + project (project wins); injected temp file is excluded from the chain. |
| `cli/src/settings-merge.ts` | When `SESSHIN_DISABLE_STATUSLINE_RELAY` is **unset** (default), merge in `{ statusLine: { type: 'command', command: '<abs-path-to-relay>' } }`. The absolute path is computed from the cli bin's location. |
| `cli/src/settings-merge.test.ts` | Two new cases: opt-out env var skips injection; injection adds the statusline command without disturbing other merged keys. |
| `cli/src/claude.ts` | Before launching Claude: call `resolveInheritedStatusLine`; if a command is found, set `SESSHIN_USER_STATUSLINE_CMD` in the child env. (`padding` resolution is left in the helper's return type for future use; not forwarded in v1 — see "Deferred / future work".) |
| `shared/src/protocol.ts` | Add `RateLimitWindowSchema`, `RateLimitsStateSchema`, `SessionRateLimitsSchema`. Export inferred types. |
| `hub/src/rest/server.ts` | Register new route `POST /reports/rate-limits`. Body validated against `{ sessionId, five_hour: …\|null, seven_day: …\|null }`. On valid: stamp `observed_at = Date.now()`, store in registry slice, broadcast, return 204. On invalid: 400. |
| `hub/src/rest/server.test.ts` | Cover: valid payload returns 204 + broadcast fires + state stored; invalid payload returns 400 with no broadcast; unknown sessionId returns 404 (the registry must already know about this session id). |
| `hub/src/registry/` | Add a per-session `rateLimits: RateLimitsState | null` field to whatever shape currently holds per-session data. Plumbed through subscribe-replay. |
| `hub/src/wire.ts` | Add `session.rate-limits` to the broadcast payload union; include current value in subscribe-replay frames. |
| `hub/src/wire.test.ts` | Extend the existing replay-shape test to assert `session.rate-limits` is included when state exists. |
| `debug-web/src/store.ts` | New slice: `rateLimits: Map<string, RateLimitsState>`, `applyRateLimits(sessionId, state)`. Wire into the existing WS dispatcher for `session.rate-limits`. |
| `debug-web/src/store.test.ts` | Extend with dispatch + replay-hydration cases. |
| `debug-web/src/components/RateLimitsPill.tsx` (new) | The pill component. Reads from store, ticks every 30 s, renders both windows + relative reset, applies color thresholds. |
| `debug-web/src/components/RateLimitsPill.test.tsx` (new) | Render-state matrix: no data; null/null; fresh; stale; color thresholds at 70 / 90; countdown tick via fake timers. |
| `debug-web/src/components/SessionDetail.tsx` | Add `<RateLimitsPill sessionId={s.id} />` as a third child of the existing flex header row at line 39. |

`packages/cli/dist/*` is a build artifact; only `src/` files are edited and the build pipeline regenerates `dist/`.

## Public contracts

### Wire schemas (`shared/src/protocol.ts`)

```ts
export const RateLimitWindowSchema = z.object({
  used_percentage: z.number(),  // 0-100, as CC reports
  resets_at: z.number(),        // Unix seconds
});

export const RateLimitsStateSchema = z.object({
  five_hour: RateLimitWindowSchema.nullable(),
  seven_day: RateLimitWindowSchema.nullable(),
  observed_at: z.number(),      // Unix ms, hub-stamped on receive
});

export const SessionRateLimitsSchema = z.object({
  type: z.literal('session.rate-limits'),
  sessionId: z.string(),
  rateLimits: RateLimitsStateSchema,
});

export type RateLimitWindow    = z.infer<typeof RateLimitWindowSchema>;
export type RateLimitsState    = z.infer<typeof RateLimitsStateSchema>;
export type SessionRateLimits  = z.infer<typeof SessionRateLimitsSchema>;
```

### REST endpoint (`hub/src/rest/server.ts`)

```
POST /reports/rate-limits
  Content-Type: application/json
  Body: { sessionId: string, five_hour: RateLimitWindow | null, seven_day: RateLimitWindow | null }

  204 No Content   on success
  400 Bad Request  on schema violation
  404 Not Found    when sessionId is unknown to the registry
```

The handler stamps `observed_at = Date.now()` on receive, stores the resulting `RateLimitsState` in the registry, and broadcasts a `session.rate-limits` message. Returns 204 even if no clients are currently subscribed; the cache-on-write is the load-bearing side effect.

### Env vars consumed by the relay

| Var | Source | Purpose |
|---|---|---|
| `SESSHIN_HUB_URL` | injected by `cli/src/claude.ts` (already exists) | Hub base URL, default `http://127.0.0.1:9663`. |
| `SESSHIN_SESSION_ID` | injected by `cli/src/claude.ts` (already exists) | Session id included in POST body. |
| `SESSHIN_USER_STATUSLINE_CMD` | new, set by `cli/src/claude.ts` | Resolved original `statusLine.command` from the CC settings hierarchy, **walking project-local → project → user** (CC's normal chain minus our injected `--settings` temp file). Enterprise managed-settings (`/etc/claude-code/managed-settings.json` on Linux, `/Library/Application Support/ClaudeCode/...` on macOS) are out of scope for v1 — see "Deferred / future work". Empty string and unset are treated identically — both cause the relay to render its default. |

### Env var consumed by the CLI

| Var | Effect |
|---|---|
| `SESSHIN_DISABLE_STATUSLINE_RELAY=1` | `settings-merge.ts` skips injecting our `statusLine` entirely. The user's original setting (if any) takes effect via normal CC resolution; no rate-limit data is captured for that session. |

## Relay execution per tick

```
1. Read stdin into a buffer (small JSON, typically a few KB).
2. JSON.parse(buffer); extract `rate_limits` if present.
3. fire-and-forget POST to ${SESSHIN_HUB_URL}/reports/rate-limits
   - body: { sessionId, five_hour, seven_day }   // both may be null
   - 250 ms timeout, errors swallowed (no stderr noise on hub-down)
4. If SESSHIN_USER_STATUSLINE_CMD is set:
     spawn(['sh', '-c', "$SESSHIN_USER_STATUSLINE_CMD"], { stdin: <buffer>, timeout: 1500 ms })
     pipe child stdout → our stdout
     on non-zero exit, timeout, or spawn error: render default
   Else:
     render default
5. exit
```

`sh -c` is used to match Claude Code's own statusline execution semantics (pipelines, env-var expansion, etc.) without re-implementing a parser.

### Default render

When the relay must produce its own output (no wrapped command, or wrap failed), and `rate_limits` was successfully extracted:

```
5h: 45% · 7d: 23%
```

When `rate_limits` is absent (API-key user, or pre-first-API-call) and there is no wrapped command, the relay outputs the empty string. CC TUI renders a blank statusline area. We do **not** add sesshin branding to the default render — the goal of the default is to be unobtrusive when the feature isn't applicable.

## Edge cases

All cases must fail toward "Claude Code TUI keeps working." The relay's exit must always be quick and clean.

| Case | Behavior |
|---|---|
| Hub unreachable / hub down | POST times out at 250 ms; wrap+render proceed normally. |
| User's wrapped command exits non-zero | Log a single line to stderr, fall back to default render. |
| User's wrapped command hangs >1500 ms | SIGTERM, then render default. CC's own statusline timeout is ~3 s, we want to fail before CC does. |
| User's wrapped command writes empty stdout | Render whatever it produced (empty is fine). |
| CC sends malformed JSON on stdin | Skip POST (no `rate_limits` to extract); still pass the **raw original buffer** to the wrapped command unchanged. Do not attempt parse-and-reserialize. |
| `rate_limits` field absent from CC's JSON | POST with `five_hour: null, seven_day: null` so the hub can distinguish "session has no quota data" from "session never reported". |
| `rate_limits` partially present (only one window) | POST what we have; the other field is `null`. |
| Relay binary crashes | CC briefly shows blank statusline area until next render; the parent CLI logs the crash via existing logger. |
| User's enterprise-level `statusLine` exists | **Not honored in v1.** `resolveInheritedStatusLine` walks project-local → project → user only; enterprise managed-settings paths are platform-specific and deferred. |

## UI behavior in `debug-web`

### Placement

The pill is a third child of the existing flex header row at `SessionDetail.tsx:39`, alongside `StateBadge` and `ModeBadge`. No new layout, no real-estate cost, no scroll behavior changes.

### Render states

| Store state for sessionId | Render |
|---|---|
| Not in `rateLimits` map (no report received) | Pill **not rendered**. Avoids a "—" placeholder flicker on session open. |
| `five_hour: null && seven_day: null` (API-key user) | Pill **not rendered**. The feature is Pro/Max-specific. |
| Fresh (`Date.now() - observed_at < 10 min`) | Full opacity, color thresholds applied. |
| Stale (`Date.now() - observed_at >= 10 min`) | `opacity: 0.5` + ⏱ icon, native `title=` tooltip indicates last-update timestamp. |

### Pill content

```
5h: 45% · 7d: 23% · in 2h 12m
```

The relative time-to-reset is **client-ticked** every 30 s using a `setInterval` inside the component (cleared on unmount). `resets_at` is anchored, so no server roundtrip is needed for the countdown to stay accurate. When the countdown reaches zero, the pill keeps rendering the last-known value; the next statusline tick replaces it with the new window's numbers.

### Color thresholds (5h utilization)

| Used | Color |
|---|---|
| < 70% | default `#eee` |
| 70 – 90% | `#f59e0b` (amber) |
| > 90% | `#ef4444` (red) |

Same scheme is **not** applied to the 7d window — it moves slowly and double-coloring would be visually noisy. The 7d number is rendered in the secondary muted color regardless.

### Tooltip (native `title=`)

```
5h window: 45% used, resets at 14:32 (in 2h 12m)
7d window: 23% used, resets Mon 09:00 (in 5d 18h)
last update: 10s ago
```

No popover library, no custom hover state — just a `title` attribute on the pill's outer element.

## Testing strategy

| Layer | File | Coverage |
|---|---|---|
| Unit | `cli/src/statusline-relay/relay.test.ts` (new) | All eight edge cases from the table above; fake `fetch`, `spawn`, `stdout`, `stderr`, `env`. |
| Unit | `cli/src/read-claude-settings.test.ts` (extend) | Three new cases for `resolveInheritedStatusLine`. |
| Unit | `cli/src/settings-merge.test.ts` (extend) | Opt-out env var; injection without disturbing other keys. |
| Unit | `hub/src/rest/server.test.ts` (extend) | Valid payload (204 + broadcast + store); invalid (400); unknown session (404). |
| Unit | `hub/src/wire.test.ts` (extend) | Replay frame includes `session.rate-limits` when state exists. |
| Unit | `debug-web/src/store.test.ts` (extend) | WS dispatch + replay-hydration paths. |
| Unit | `debug-web/src/components/RateLimitsPill.test.tsx` (new) | Render-state matrix; color thresholds; countdown tick via fake timers. |

No end-to-end test against a live Claude Code instance is in scope. The relay's edge cases are exhaustively covered with injected dependencies, and the data path from `POST /reports/rate-limits` through to the rendered pill is unit-covered at every hop.

## Deferred / future work

- **Account-aggregated readout.** A second pill (or sidebar widget) that surfaces "freshest across all live sessions" to avoid the visual duplication when multiple sesshin sessions share one Anthropic account.
- **History and trend graph.** Hub appends each report to a JSONL log; a separate panel charts utilization over the last N hours.
- **Active probe.** Hub periodically initiates a low-cost API call to refresh stale data without waiting for the next CC re-render. Requires reusing the user's auth token and is risky around self-rate-limiting.
- **Per-session-secret auth between relay and hub.** Currently loopback-only and unauthenticated, same as `hook-handler`. If sesshin grows a multi-tenant story, this needs revisiting jointly with `hook-handler`.
- **Wrap user's statusline in a non-shell context.** `sh -c` covers the realistic case but means we cannot safely run a wrapped command on a system without `/bin/sh`. Not a realistic concern for the platforms sesshin targets, but worth noting.
