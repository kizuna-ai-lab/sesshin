# Session-context guard for `/sesshin-*` slash commands

**Date:** 2026-05-05
**Status:** Design — pending implementation

## Problem

The eight `/sesshin-*` slash commands (`status`, `clients`, `history`, `trust`, `gate`, `pin`, `quiet`, `log`) are installed system-wide via `sesshin commands install`, so they are visible inside every Claude Code session — including plain `claude` sessions that were not launched by `sesshin claude`. Their bash bodies all expand `$SESSHIN_SESSION_ID` directly:

```bash
sesshin status --session $SESSHIN_SESSION_ID --json
```

`SESSHIN_SESSION_ID` and `SESSHIN_HUB_URL` are only injected by `sesshin claude` when it spawns the child claude process (`packages/cli/src/claude.ts:79-83`). In a plain claude session both are unset, so:

1. The bash command becomes `sesshin status --session  --json`. With `$VAR` unquoted, the empty field is dropped from argv entirely; `pickFlag(rest, '--session')` then returns the next token (`--json`), silently treating `--json` as the session id.
2. Even when the env var happens to be set to a stale value, the sesshin hub is almost certainly not running — `ensureHubRunning` is only called from the `sesshin claude` path. The CLI subcommand fails with an opaque `fetch failed` from undici.
3. Three `sesshin <subcmd>` handlers (`status`, `clients`, `log`) accept missing session ids without complaint and pass `undefined` to the hub, producing yet another shape of failure.

The user-visible result inside a non-sesshin claude is a confusing wall of stack traces or empty responses with no hint about *why*. The slash commands need a guard.

## Scope

**In:**

1. New `requireLiveSession()` helper in `packages/cli/src/require-live-session.ts` that classifies the session-context state into one of `ok` / `no-env` / `hub-down` / `orphan-session`.
2. Centralized gate in `packages/cli/src/main.ts`: every "session-required" subcommand goes through the helper before dispatch. On any not-ok result the gate writes a fixed-prefix diagnostic to stderr and exits with code `3`.
3. New hub route `GET /api/sessions/:id` returning `200 + minimal JSON` when the session is in the registry, `404` otherwise. Used as the existence probe.
4. Hardening of `pickFlag` so a token starting with `--` is never accepted as a flag value.
5. Markdown updates to all eight `*.md` slash command bundles: a fixed trailing block instructing the LLM how to interpret the new error prefix, plus quoting `"${SESSHIN_SESSION_ID:-}"` in the bash body.
6. Unit tests for `requireLiveSession` (six branches via injected fake `fetch`), gate integration in `main.test.ts`, and one hub route test (200 vs 404).

**Out (explicitly deferred):**

- No retry / backoff on the hub probe. Local 127.0.0.1 round-trip; if it times out once, the sesshin runtime is in trouble and the user needs to know.
- No caching of the probe result. Every slash command re-probes; the cost is negligible.
- No new bypass flag (e.g. `--no-guard`). If a user genuinely needs to talk to a hub they didn't launch, `--session <id>` already targets it explicitly; the gate still validates that session against the running hub.
- No e2e test against a real hub. The helper takes `fetch` as an injected dependency; covering all branches with a fake is sufficient and faster.

## Architectural fit

The gate sits in the CLI process boundary, before any subcommand handler runs. It does not modify hub state, does not subscribe to anything, and does not depend on any subcommand-specific code. The new `GET /api/sessions/:id` route is additive and read-only; it reuses `deps.registry.get(id)`, the same lookup already used by the heartbeat / raw / inject / sink-stream handlers for their own existence checks.

Slash command markdown does not change its `allowed-tools` allowlist — the gate keeps the existing `Bash(sesshin <subcmd>:*)` invocation as the single bash call, and reuses its stderr to communicate failure. The LLM in the parent claude session pattern-matches on the fixed prefix and explains to the user.

## File-level change map

| Package / file | Change |
|---|---|
| `cli/src/require-live-session.ts` (new) | Export `requireLiveSession(deps)`; pure function over injected `env`, `explicitSessionId`, `fetch`, `hubProbeTimeoutMs`. |
| `cli/src/main.ts` | Add `SESSION_REQUIRED` set; before `switch`, if `cmd ∈ SESSION_REQUIRED` run `requireLiveSession`; on not-ok, write message to stderr, return `3`. Harden `pickFlag` so it returns `undefined` (not the raw value) when the next token is missing, the empty string, or starts with `--`. |
| `cli/src/require-live-session.test.ts` (new) | Six branches via fake `fetch`: env unset; explicit sid starts with `--`; fetch throws `TypeError`; fetch aborted; 200; 404. |
| `cli/src/main.test.ts` (new or extended) | Gate integration: a session-required subcommand exits 3 with the fixed prefix when env unset; `claude` subcommand bypasses the gate; hardened `pickFlag` no longer treats `--json` as a session id. |
| `hub/src/rest/server.ts` | The existing `/^\/api\/sessions\/([^/]+)$/` block currently handles only `DELETE`. Extend it to handle `GET`: call `deps.registry.get(id)`; `404` on miss; `200 + JSON.stringify({ id })` on hit. The minimal body is enough for a probe; richer fields can be added later without breaking callers. |
| `hub/src/rest/server.test.ts` (extend) | One test for `GET /api/sessions/:id`: registered → 200; unregistered → 404. |
| `cli/src/commands-bundle/sesshin-status.md` | Quote `--session "${SESSHIN_SESSION_ID:-}"`; append guard footnote (see below). |
| `cli/src/commands-bundle/sesshin-clients.md` | Same. |
| `cli/src/commands-bundle/sesshin-history.md` | Same. |
| `cli/src/commands-bundle/sesshin-trust.md` | Same. |
| `cli/src/commands-bundle/sesshin-gate.md` | Same. |
| `cli/src/commands-bundle/sesshin-pin.md` | Same. |
| `cli/src/commands-bundle/sesshin-quiet.md` | Same. |
| `cli/src/commands-bundle/sesshin-log.md` | Same. |

`packages/cli/dist/commands-bundle/*.md` is a build artifact; only the `src/` copies are edited and the existing build pipeline regenerates `dist/`.

## Public contract: `requireLiveSession`

```ts
export type RequireSessionResult =
  | { ok: true; sessionId: string; hubUrl: string }
  | { ok: false; reason: 'no-env' | 'hub-down' | 'orphan-session'; message: string };

export interface RequireSessionDeps {
  env: { SESSHIN_SESSION_ID?: string; SESSHIN_HUB_URL?: string };
  explicitSessionId?: string;          // value of --session flag, if any
  fetch: typeof globalThis.fetch;
  hubProbeTimeoutMs?: number;          // default 1500
}

export async function requireLiveSession(deps: RequireSessionDeps): Promise<RequireSessionResult>;
```

Resolution order for the session id:

1. `explicitSessionId` (caller already validated it does not start with `--`).
2. `env.SESSHIN_SESSION_ID`.
3. None of the above, or value is an empty string, or value starts with `--` → `no-env`.

Hub url resolution:

- `env.SESSHIN_HUB_URL ?? 'http://127.0.0.1:9663'` (mirrors `claude.ts:19-20`).

Probe:

- `fetch(`${hubUrl}/api/sessions/${sid}`)` with `AbortController` set to `hubProbeTimeoutMs`.
- Network rejection, `AbortError`, or any non-2xx-non-404 status → `hub-down`.
- `404` → `orphan-session`.
- `2xx` → `ok`.

## Stderr message contract (parsed by the LLM)

All three failure cases share the prefix `sesshin: not in a live sesshin session — `, followed by a single-line, human-readable diagnostic and remediation. Exact strings:

- `no-env`: `sesshin: not in a live sesshin session — $SESSHIN_SESSION_ID is not set. To use /sesshin-* commands, launch Claude via 'sesshin claude' instead of 'claude'.`
- `hub-down`: `sesshin: not in a live sesshin session — hub at <hubUrl> is not reachable. The sesshin hub may have crashed; restart with 'sesshin claude'.`
- `orphan-session`: `sesshin: not in a live sesshin session — session <sid> is not registered with the hub. The current session is orphaned; restart with 'sesshin claude'.`

Exit code is uniformly `3`. Code `2` is preserved for the existing `usage:` errors. Code `1` remains the catch-all (uncaught helper exception, etc.).

## Slash command markdown footnote

Identical block appended to all eight `*.md` files (a single string, easy to grep / regenerate):

```
---

If this command exits with a line beginning `sesshin: not in a live sesshin session —`,
do NOT proceed. Explain to the user in their language that `/sesshin-*` commands only
work when Claude is launched via `sesshin claude` (not plain `claude`), and quote the
specific diagnostic from the error line so the user knows which sub-state applies
(env not set / hub not reachable / orphaned session).
```

## Data flows

**In-sesshin claude, `/sesshin-status`:**

1. LLM emits `sesshin status --session "$SESSHIN_SESSION_ID" --json` to the Bash tool.
2. Shell expands the env var; argv is `['status', '--session', 'abc123', '--json']`.
3. `main.ts` extracts `--session abc123`, builds `RequireSessionDeps`, calls `requireLiveSession`.
4. Helper fetches `http://127.0.0.1:9663/api/sessions/abc123`, gets `200`, returns `{ ok: true }`.
5. Gate falls through to the existing `case 'status'` dispatch; original behavior unchanged.

**Plain claude, `/sesshin-status` (env unset):**

1. LLM emits the same string. Shell expansion of unset env yields argv `['status', '--session', '', '--json']` (with the new quoting) or `['status', '--session', '--json']` (legacy, before markdown is updated).
2. Hardened `pickFlag` returns `undefined` in both cases: the empty-string value is normalized to `undefined`, and the `--json` token is rejected because it starts with `--`.
3. `requireLiveSession` sees no explicit sid, no env sid → `no-env`.
4. Gate writes the fixed-prefix line to stderr, exits `3`.
5. Bash tool surfaces stderr to the LLM; the markdown footnote tells the LLM how to translate it.

**Plain claude, env happens to be set, hub down:**

1. Helper has a sid; `fetch` rejects with `TypeError` (ECONNREFUSED) or aborts.
2. Helper returns `hub-down`. Gate prints, exits `3`.

**In-sesshin claude that was disconnected from a now-restarted hub:**

1. Helper has a sid; hub is up but the sid is unknown (hub registry was cleared on restart).
2. `GET /api/sessions/:id` returns 404 → `orphan-session`. Gate prints, exits `3`.

## Test plan

| File | Cases |
|---|---|
| `cli/src/require-live-session.test.ts` | (a) env unset → `no-env`; (b) explicit sid is `--json` → `no-env`; (c) fake fetch throws `TypeError` → `hub-down`; (d) fake fetch resolves after timeout / abort → `hub-down`; (e) fake fetch resolves `Response(null, { status: 200 })` → `ok`; (f) fake fetch resolves `Response(null, { status: 404 })` → `orphan-session`. |
| `cli/src/main.test.ts` | (a) `sesshin status` with no env, no `--session` → exits `3`, stderr starts with the fixed prefix; (b) `sesshin claude --foo` does not enter the gate (would fail the test if it did, since hub is not running in test env); (c) hardened `pickFlag(['--session', '--json'], '--session')` and `pickFlag(['--session', ''], '--session')` and `pickFlag(['--session'], '--session')` all return `undefined`. |
| `hub/src/rest/server.test.ts` | `GET /api/sessions/:id` → 200 when registered, 404 when not. |

No real-network or real-hub tests are added; the helper is fully mockable and the existing hub test infrastructure already exercises route registration.

## Out-of-scope follow-ups

- A `sesshin doctor` subcommand that runs the same probe on demand and reports which of the three sub-states applies. Useful for users debugging from outside any claude. Tracked separately if desired.
- Telemetry on how often each `reason` fires in real usage. Not needed for v1.
- Localizing the stderr message itself. The markdown footnote already instructs the LLM to translate; the raw English line is the stable contract.
