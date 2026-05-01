# Summarizer

## Goal

Convert verbose agent output into a glanceable status object:

```json
{
  "summaryId": "s-007",
  "oneLine": "Migrated 7 of 12 endpoints; 2 tests failing in payments_test.go.",
  "bullets": [
    "PaymentService.Refund now returns wrapped error",
    "TestRefund_NetworkFailure: timeout assertion outdated",
    "TestRefund_DoubleSpend: passing"
  ],
  "needsDecision": true,
  "suggestedNext": "Approve fixing the two failing tests?",
  "since": "s-006",
  "generatedAt": 1730000000000,
  "generatorModel": "claude-haiku-4-5"
}
```

This object is the unit of "what just happened" that flows to every Sesshin
client. M5Stick shows the `oneLine`. Telegram shows `oneLine + bullets +
suggestedNext`. Debug web shows everything.

## Trigger

Summaries are produced at exactly two moments:

1. On `Stop` hook (turn completion). Main path.
2. On long-stall detection (≥ 5 minutes without progress in `running`).
   Produces a "still going" update describing the most recent activity. Rate
   limited to one per 5 minutes per session.

No streaming or per-tool summaries. This keeps token cost predictable and
avoids "AI watching AI" feedback noise.

## Diff strategy

Summaries are computed against the **previous summary**, not against the full
transcript. Inputs to the summarizer:

- The previous summary's `oneLine` and `bullets` (a few hundred tokens at
  most).
- The new events since the previous summary, as a flat list:
  - `UserPromptSubmit` text
  - Tool calls (name plus truncated args)
  - Tool results (truncated)
  - Final assistant output (truncated)

Each new event is truncated to a budget (e.g. 500 chars per item, 8 KiB
total). When the budget is exceeded, oldest middle items are dropped first.
The user prompt and the final assistant output are always retained.

The summarizer prompt instructs the model to:

- Emit JSON conforming to the summary schema, no surrounding prose.
- Refer to changes "since the last update" rather than restate prior context.
- Set `needsDecision: true` only when the agent is genuinely waiting on the
  user (a question, a confirmation, an unresolved error).
- Keep `oneLine` ≤ 100 chars and `bullets` to at most 5 items of ≤ 80 chars
  each.

## Modes

Sesshin chooses one of three modes per session, in order of preference. The
choice is made automatically when the session is registered.

### Mode B′: Claude direct OAuth API call (PRIMARY for Claude Code)

Sesshin reads the user's existing Claude Code OAuth token from
`~/.claude/.credentials.json` (or the OS keyring on platforms where
Claude Code stores it there) and calls the Anthropic Messages API
directly. Verified working on a Claude Max account on 2026-05-02; see
`docs/validation-log.md` Section 9 for empirical results and
`prototypes/mode-b-prime.mjs` for a 130-line working reference
implementation.

The credentials file has a wrapper layout — Sesshin reads
`claudeAiOauth.accessToken` (and `claudeAiOauth.refreshToken`,
`claudeAiOauth.expiresAt`). Reading flat field names at the root will
fail.

```
POST https://api.anthropic.com/v1/messages?beta=true

Authorization: Bearer <accessToken>
anthropic-version: 2023-06-01
anthropic-beta: oauth-2025-04-20
anthropic-dangerous-direct-browser-access: true
x-app: cli
User-Agent: claude-cli/<version> (external, cli)
Content-Type: application/json
Accept: application/json
Accept-Encoding: identity
```

Body:

```text
{
  "model": "claude-haiku-4-5",
  "max_tokens": 250,
  "system": [
    { "type": "text",
      "text": "You are Claude Code, Anthropic's official CLI for Claude.",
      "cache_control": { "type": "ephemeral" } },
    { "type": "text", "text": "<sesshin summarizer instructions>" }
  ],
  "messages": [{ "role": "user", "content": "<prompt body>" }],
  "metadata": { "user_id": "user_<hex>_account__session_<hash>" }
}
```

Server-side requirements (any deviation returns 401 or 400):

- `anthropic-beta` MUST contain `oauth-2025-04-20`. Omitting it returns
  `401 OAuth authentication is currently not supported.` Other beta
  features can be appended (comma-separated) when needed:
  `claude-code-20250219`, `interleaved-thinking-2025-05-14`,
  `fine-grained-tool-streaming-2025-05-14`. The Haiku non-streaming
  default is just `oauth-2025-04-20`.
- The first `system` block MUST contain the literal string
  `You are Claude Code, Anthropic's official CLI for Claude.`
  Sesshin's actual summarizer instructions follow as a second block.
  This mirrors the Codex `instructions`-prefix and Gemini's bundled
  persona.
- `metadata.user_id` is required and follows the format
  `user_<hex>_account__session_<hash>`; in our testing random hex
  values are accepted, though we should prefer deriving the user
  portion from the JWT `sub` claim if Anthropic ever tightens the
  validation.

Token refresh: when `claudeAiOauth.expiresAt - now` is under 60
seconds, Sesshin POSTs to
`https://console.anthropic.com/v1/oauth/token` with
`grant_type=refresh_token`, `refresh_token=<stored>`,
`client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e`. The response yields
new `access_token`, `refresh_token`, `expires_in` fields; Sesshin
writes them back atomically (temp file + fsync + rename) preserving
mode 0600 so Claude Code's concurrent reads stay consistent.

Performance characteristics (empirically measured 2026-05-02, Max
subscription, claude-haiku-4-5):

- Latency: 0.9-1.5 s end-to-end (vs 4-6 s for Mode B subprocess).
- Input tokens: 65-88 per call for short prompts (vs ~50 k for Mode B
  warm cache, ~80 k cold). The whole point of B′: only the actual
  payload, no bundled Claude Code system context.
- Output tokens: scales with `max_tokens` and content; 16-29 in our
  test calls.
- Real dollar cost on subscription: not reported by the OAuth-bearer
  endpoint (the dollar field that `claude -p` prints does not appear
  in raw Messages API output). Token counts above are what gets
  charged against Claude.ai weekly quota.

ToS posture: gray. Sesshin's use is read-your-own-credentials, on the same
machine, to assist the same user — much closer to subscription intent than
multi-tenant relays. Still, the Anthropic API endpoint and OAuth tokens are
not officially exposed for non-Claude-Code use, and the impersonated
`User-Agent` is unsanctioned. Documented prominently in the README so users
choose this consciously.

Failure modes:

- Token refresh fails (invalid refresh_token, account suspended) → fall
  through to Mode B.
- API call returns 4xx/5xx → fall through to Mode B for the failing call,
  then retry Mode B′ on next call.
- Anthropic changes the OAuth client_id, scopes, or required headers →
  detect via 401/403 cluster, fall through to Mode B until manually fixed.

### Mode B: Claude Code subprocess (FALLBACK for Claude Code)

```
claude -p \
  --model claude-haiku-4-5 \
  --output-format json \
  --tools "" \
  --no-session-persistence \
  --exclude-dynamic-system-prompt-sections \
  --system-prompt "<sesshin summarizer system prompt>" \
  '<prompt body>'
```

Used when Mode B′ fails (token refresh failure, repeated 4xx, version skew
after Claude Code update).

Empirical numbers:

- Latency 4-6 s.
- ~80k cached system context loaded on first call, ~50% caches across
  calls.
- `total_cost_usd` reported is informational; on subscription, dollar cost
  is zero but the call counts against weekly quota proportional to actual
  tokens (so the 22-80k system context is a real quota burn).

`--exclude-dynamic-system-prompt-sections` improves cache reuse by moving
per-machine fields (cwd, env, git status) into the first user message.

### Mode C′: Codex direct OAuth API call (PRIMARY for Codex)

Sesshin reads the user's existing Codex CLI OAuth tokens from
`~/.codex/auth.json` and calls the ChatGPT Codex backend API directly.

The local file schema (verified empirically):

```json
{
  "OPENAI_API_KEY": null,
  "tokens": {
    "id_token":      "<JWT, ~2 kB>",
    "access_token":  "<bearer, ~1.9 kB>",
    "refresh_token": "<~90 chars>",
    "account_id":    "<UUID>"
  },
  "last_refresh": "<ISO timestamp>"
}
```

Request (verified working 2026-05-02; see `docs/validation-log.md`
Section 10 and `prototypes/mode-c-prime.mjs`):

```
POST https://chatgpt.com/backend-api/codex/responses
   (the /compact path is for conversation compaction, NOT a
   non-streaming chat endpoint — do not use)
Authorization: Bearer <tokens.access_token>
chatgpt-account-id: <tokens.account_id>
Accept: text/event-stream
Content-Type: application/json
User-Agent: codex_cli_rs/<version>
originator: codex_cli_rs
session_id: <UUID v4 we generate per call>
```

Body (Responses API streaming format):

```text
{
  "model": "gpt-5.4-mini",
  "instructions": "You are Codex, based on GPT-5. You are running as a coding agent in the Codex CLI. <sesshin summarizer instructions>",
  "input": [
    { "type": "message", "role": "user",
      "content": [{ "type": "input_text", "text": "<prompt body>" }] }
  ],
  "stream": true,
  "store": false
}
```

Server-side requirements (any deviation returns 4xx):

- `User-Agent` MUST match `^(codex_vscode|codex_cli_rs|codex_exec)/[\d.]+`.
  The `originator` header must match the client kind extracted from
  User-Agent.
- `session_id` is required (UUID v4 works).
- The `instructions` field MUST begin with the literal string
  `"You are Codex, based on GPT-5. You are running as a coding agent
  in the Codex CLI"`. Sesshin appends its summarizer instructions
  after this prefix.
- The `model` field MUST be one returned by the model-discovery
  endpoint (see below); standard OpenAI model names like `gpt-4o-mini`,
  `gpt-5-mini` are rejected with `"The 'X' model is not supported when
  using Codex with a ChatGPT account."` Use the discovery endpoint to
  get currently-supported names.
- `stream: true` is REQUIRED on `/responses`. The `/compact` path is
  a separate feature (conversation compaction, not chat) — do not use
  it for summaries.
- `input` items use `content[].type = "input_text"` (not Anthropic's
  flat `text` field).

Model discovery: before the first call, GET
`https://chatgpt.com/backend-api/codex/models?client_version=<v>` with
the same auth/UA headers. Response: `{ models: [{ id, ... }, ...] }`.
Cache the list with a TTL (codex-cli uses 5 minutes); pick a
"-mini" variant when available (cheapest fast model).

Token refresh: when `access_token` JWT `exp` is within 60 seconds of
now (decode the JWT payload to find it; do NOT use `last_refresh` or
the `id_token`'s expiry — they're independent), Sesshin POSTs to
`https://auth.openai.com/oauth/token` with
`Content-Type: application/x-www-form-urlencoded` and body
`grant_type=refresh_token&client_id=app_EMoamEEZ73f0CkXaXp7hrann
&refresh_token=<tokens.refresh_token>&scope=openid+profile+email`,
then writes the updated tokens back atomically.

SSE parsing: events of `type: "response.output_text.delta"` carry
streaming `delta` chunks. The `type: "response.completed"` event
carries the final `response` object including `usage`. v1 summarizer
ignores deltas (since it only emits one summary object); a debug-web
client may want to render them for streaming.

Performance characteristics (empirically measured 2026-05-02, ChatGPT
account, gpt-5.4-mini, three runs):

- TTFB: 660-960 ms; total: 1.5-2.0 s (vs 4-6 s for Mode C subprocess).
- Input tokens: 60-77 per short call (vs ~22 k for Mode C). ~370× lower.
- Output tokens: 24-30.
- Transient 503s ("upstream connect error / disconnect/reset before
  headers") happen occasionally; production code retries once with
  fresh request context (don't reuse the streaming reader).

ToS posture: same gray as Mode B′ / G′. Single-user, single-machine,
no upload.

Failure modes mirror Mode B′: 4xx cluster on header/version skew → fall
through to Mode C; refresh failure → fall through; consecutive failures
→ disable the direct path until manually re-validated.

### Mode C: Codex exec subprocess (FALLBACK for Codex)

```
codex exec \
  --ignore-user-config \
  --ignore-rules \
  --ephemeral \
  --skip-git-repo-check \
  --sandbox read-only \
  --json \
  -m <fast-model> \
  --output-schema <path-to-summary-schema.json> \
  '<prompt body>'
```

Used when Mode C′ fails (token refresh failure, repeated 4xx, version
skew after Codex CLI update).

Empirical baseline: ~22 k input tokens after `--ignore-user-config
--ignore-rules --ephemeral`, of which roughly 30% caches. `--output-schema`
constrains the model to the Sesshin summary schema directly.

Output is JSONL. The final answer is in the event with
`type: "item.completed"`, where `item.type == "agent_message"` and the text
is in `item.text`. Token usage is in the trailing `turn.completed` event.

### Mode G′: Gemini direct OAuth API call (PRIMARY for Gemini)

Sesshin reads the user's existing Gemini CLI OAuth tokens from
`~/.gemini/oauth_creds.json` and calls the Google Cloud Code Assist
API directly.

OAuth constants (from `claude-relay-service` Gemini support and Google's
Code Assist OAuth flow):

- Auth URL: standard Google OAuth 2.0 + PKCE (`code_challenge_method=S256`)
- Token URL: `https://oauth2.googleapis.com/token`
- Scopes: `https://www.googleapis.com/auth/cloud-platform`
- Redirect URI: `https://codeassist.google.com/authcode` (the Gemini CLI
  uses this; Google Antigravity uses `http://localhost:45462`)
- The `client_id` is shared across the public Gemini CLI builds; pull
  from current Gemini CLI source at implementation time rather than
  hard-coding.

Local credential file schema (verified empirically with gemini-cli
0.40.1 on 2026-05-02):

```json
{
  "access_token":  "<~258 chars>",
  "refresh_token": "<~103 chars>",
  "scope":         "<~149 chars; space-separated list>",
  "token_type":    "Bearer",
  "id_token":      "<JWT, ~1149 chars>",
  "expiry_date":   1700000000000
}
```

`expiry_date` is a Unix epoch in milliseconds.

Companion files at `~/.gemini/`:

- `google_accounts.json` — `{ active: <email>, old: [...] }`. The
  `active` field identifies which Google account the credentials
  belong to.
- `settings.json` — user settings, including auth selection and (when
  configured) hooks. Default content is just
  `{ "security": { "auth": { "selectedType": "oauth-personal" } } }`.

Workspace / Cloud users additionally need a `projectId` in the
request body (`cloudaicompanionProject`); personal Google accounts on
the free tier are auto-provisioned.

Verified working 2026-05-02; see `docs/validation-log.md` Section 11
and `prototypes/mode-g-prime.mjs` for a 215-line reference
implementation.

```
POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist
POST https://cloudcode-pa.googleapis.com/v1internal:generateContent

Authorization: Bearer <access_token from oauth_creds.json>
Content-Type: application/json
User-Agent: GeminiCLI/<version>/<model> (<platform>; <arch>; gemini-cli)
```

That's the entire header set. No `x-goog-*` headers are required.

`:loadCodeAssist` body:

```text
{
  "metadata": {
    "ideType": "IDE_UNSPECIFIED",
    "platform": "LINUX_AMD64" | "DARWIN_AMD64" | "PLATFORM_UNSPECIFIED",
    "pluginType": "GEMINI",
    "pluginVersion": "<gemini-cli version>"
  }
}
```

Response: `{ currentTier, allowedTiers, cloudaicompanionProject, ... }`.
For free-tier OAuth users a `cloudaicompanionProject` is
auto-provisioned (Sesshin observed value `upbeat-portfolio-1frtp`).
Sesshin caches this value per session — `:loadCodeAssist` only needs
to be called once per session, not per summary.

`:generateContent` body (schema is `CAGenerateContentRequest` from
gemini-cli source):

```text
{
  "model": "gemini-2.5-flash",
  "project": "<cloudaicompanionProject from loadCodeAssist>",
  "user_prompt_id": "<UUID>",
  "request": {
    "contents":          [{ "role": "user", "parts": [{ "text": "<prompt>" }] }],
    "systemInstruction": { "role": "user", "parts": [{ "text": "<system>" }] },
    "generationConfig": {
      "maxOutputTokens": 250,
      "temperature": 0.7,
      "thinkingConfig": { "thinkingBudget": 0 }
    },
    "session_id": "<UUID>"
  }
}
```

Server-side requirements (or strong recommendations):

- `User-Agent` MUST start with `GeminiCLI/`. The full format observed
  in gemini-cli source is
  `GeminiCLI/<version>/<model> (<platform>; <arch>; <surface>)` where
  `<surface>` is typically `gemini-cli` or `acp-vscode`. A simpler
  `GeminiCLI/<version>` is also accepted.
- `model` MUST be a model the user's tier has access to. For free-tier
  OAuth users on individuals tier, `gemini-2.5-flash` is the standard
  choice. The exact list is published by gemini-cli's own
  `models_cache.json` and via Code Assist's tier metadata.
- `project` is REQUIRED for individuals on the free tier (the
  `cloudaicompanionProject` returned by `:loadCodeAssist`). Omitting
  it returns a 403 telling you to provide one.
- `thinkingConfig: { thinkingBudget: 0 }` is essential for ambient
  summaries on Gemini 2.5. Without it the model emits 200+ "thoughts"
  tokens for trivial outputs, tripling latency and consuming quota
  without producing visible value.
- No magic prompt prefix is required (unlike Claude's "You are Claude
  Code" or Codex's "You are Codex, based on GPT-5"). Sesshin's
  summarizer instructions go directly into
  `systemInstruction.parts[].text`.
- For streaming use `:streamGenerateContent` instead of
  `:generateContent`; v1 summarizer uses the non-streaming path.
- A sandbox host `https://daily-cloudcode-pa.sandbox.googleapis.com`
  exists for Antigravity development; production should always hit
  `cloudcode-pa.googleapis.com`.

Token refresh: when `expiry_date - now` is under 60 seconds, Sesshin
POSTs to `https://oauth2.googleapis.com/token` with
`Content-Type: application/x-www-form-urlencoded` and body
`grant_type=refresh_token&client_id=<gemini-cli's public client_id>
&client_secret=<gemini-cli's public client_secret>
&refresh_token=<creds.refresh_token>`. Note Google REQUIRES both
`client_id` and `client_secret` here even though they're embedded
in gemini-cli's binary (not user-specific). The literal values are
not committed to this repo to avoid tripping secret scanners; v1
implementation should read them from the installed gemini-cli at
runtime. Response yields new `access_token` and `expires_in`;
Sesshin updates `expiry_date = now + expires_in*1000` and writes
back atomically.

Free-tier 429s with `RetryInfo.retryDelay` happen on rapid-fire
calls; production code MUST honor the suggested retry delay. The v1
summarizer's 1-summary-per-Stop-event cadence is unlikely to trip
this in normal use.

Performance characteristics (empirically measured 2026-05-02,
individuals free tier, gemini-2.5-flash, three runs after disabling
thinking):

- generateContent latency: 1.3-2.0 s.
- loadCodeAssist latency: 0.8-1.6 s, ONCE per session (cache the
  returned project ID).
- Input tokens: 39-57 (vs ~2,900 for Mode G warm). ~50× lower.
- Output tokens (visible): 4-17. Plus zero thoughts when
  `thinkingBudget: 0`; up to 240 thoughts when thinking is on (avoid).

Note that Mode G′'s improvement over Mode G is smaller than B′-vs-B or
C′-vs-C (50× vs 600× / 370×) because Gemini's bundled context is
already much smaller. The latency improvement is also modest. Mode G′
is still preferred for consistency of pattern and for the absence of
Gemini-CLI-imposed startup overhead.

Token refresh: when `expiry_date` is within 60 seconds, Sesshin POSTs to
`https://oauth2.googleapis.com/token` with `grant_type=refresh_token`
plus the stored `refresh_token`, then writes the updated tokens back
atomically.

Performance characteristics:

- Latency: ~50-200 ms (vs 4-6 s for Mode G subprocess).
- Tokens against Gemini quota: ~2 k per call (Sesshin's payload only)
  vs ~22 k+ for Mode G (Gemini CLI's bundled context).
- Free-tier API key accounts have a very limited quota and 429 readily;
  prefer OAuth accounts for non-trivial use. Sesshin surfaces 429s as
  attention events.

Caveats specific to Gemini:

- Workspace / Cloud accounts require `projectId` (passed as
  `cloudaicompanionProject` in Code Assist requests). Personal Google
  accounts on the free tier do not require it.
- The `gemini-cli` itself is dual-mode (Code Assist API for OAuth users,
  Generative Language API for API-key users); Sesshin must detect which
  mode the local install is in before crafting requests.

ToS posture: gray, same as Mode B′ / C′. The `v1internal` endpoint is
not an officially documented public surface; the impersonated User-Agent
is the price of access. Single-user, single-machine, no upload.

### Mode G: Gemini subprocess (FALLBACK for Gemini)

```
cd $HOME && \
gemini -p '<prompt body>' \
  -o json \
  --skip-trust \
  -e '' \
  -m gemini-2.5-flash
```

Empirically verified on gemini-cli 0.40.1, 2026-05-02:

- `-e ''` disables all extensions (no GEMINI.md auto-load, no MCP
  servers, no skills).
- `--skip-trust` is required for non-interactive use in any directory
  not in `~/.gemini/trustedFolders.json`. Sesshin runs the summarizer
  from `$HOME` (which is typically trusted) but passing this flag
  removes the dependency.
- `-o json` returns:
  ```text
  {
    "session_id": "<uuid>",
    "response":   "<final text>",
    "stats": {
      "models": {
        "<model>": {
          "tokens": { "input": ..., "candidates": ..., "thoughts": ..., "total": ..., "cached": ... },
          "api":    { "totalRequests": 1, "totalLatencyMs": ... }
        }
      }
    }
  }
  ```
- Token cost: ~10.7 k input cold; **~2.9 k input on warm cache** (within
  the same minute on the same machine); 17 candidate + ~600 "thoughts"
  tokens output. ~5 second latency.
- Compare to Claude `-p` (80 k cold / 50 k warm) and `codex exec`
  (22 k cold). Gemini's bundled context is small enough that Mode G
  is a perfectly viable fallback when Mode G′ misbehaves; the design
  still prefers G′ as primary so Gemini behaves consistently with
  Claude and Codex (direct-API default, subprocess fallback).

Used when Mode G′ fails (token refresh failure, repeated 4xx, version
skew after Gemini CLI update).

### Mode selection

Pseudocode the hub runs once at session registration:

```
if session.agent == "claude-code":
    if oauth_credentials_present_and_valid("~/.claude/.credentials.json"):
        mode = "claude-direct"      # B′
    else:
        mode = "claude-subprocess"  # B

elif session.agent == "codex":
    if oauth_credentials_present_and_valid("~/.codex/auth.json"):
        mode = "codex-direct"       # C′
    else:
        mode = "codex-subprocess"   # C

elif session.agent == "gemini":
    if oauth_credentials_present_and_valid("~/.gemini/oauth_creds.json"):
        mode = "gemini-direct"      # G′
    else:
        mode = "gemini-subprocess"  # G

else:
    mode = "fallback-heuristic"
```

The user can override per session via a `sesshin <agent> --summarizer ...`
flag or in `~/.config/sesshin/config.toml`.

All three agents follow the same uniform pattern: direct-API mode is
default, subprocess mode is fallback when the direct path fails. v1
considers only OAuth/subscription users for all three agents; separate
API-key paths (Anthropic API key, Gemini API key) are out of scope.

## Common implementation notes

- The direct-API modes (B′, C′, G′) keep OAuth tokens in memory only
  after reading the credentials file. Refreshed tokens are written back
  atomically (write to temp file, fsync, rename) to avoid corrupting the
  file the agent CLI itself reads. File modes are preserved (0600).
- The subprocess modes (B, C, G) inherit the user's environment, so
  credentials are picked up automatically. The hub never spawns the
  agent with credentials baked into argv.
- The subprocess modes run in the user's home directory by default,
  **not** in the agent's working directory. This avoids the summarizer
  accidentally indexing the project, picking up `CLAUDE.md` /
  `GEMINI.md` instructions, or invoking project-scoped tools.
- The prompt explicitly instructs the model not to call any tool, as
  belt-and-braces reinforcement on top of `--tools ""` (Mode B) /
  `--ignore-user-config` (Mode C) / Gemini's equivalent (Mode G).
  Direct-API modes do not expose tools at all.
- Timeouts: subprocess modes 30 s; direct-API modes 15 s. On timeout the
  call is aborted and the fallback path runs.
- Sesshin tracks per-session and per-day quota usage and emits an
  attention event when daily token spend crosses a user-configurable
  threshold.

## Validation log

Empirical results from invocations on 2026-05-01 against the user's actual
CLI installs. Full command outputs in `docs/validation-log.md`.

1. `claude -p` accepts `--model claude-haiku-4-5` and `--output-format json`.
   Confirmed.
2. `claude -p` runs in a separate process and does not modify the parent
   Claude Code session's conversation. Confirmed by `session_id`
   observation: each invocation gets a fresh id.
3. `claude -p` on OAuth/subscription works without `ANTHROPIC_API_KEY`.
   Confirmed. `--bare` does **not** work on OAuth/subscription
   (`Not logged in · Please run /login`); we therefore ignore the API-key
   path entirely.
4. Cost model: Claude reports `total_cost_usd` per call. On subscription,
   the dollar value is informational; what is actually consumed is the
   subscription's weekly token quota. Mode B burns ~22-80k of that per
   call; Mode B′ burns ~2k. This is the primary motivation for making
   Mode B′ the default.
5. `codex exec` accepts `--ignore-user-config --ignore-rules --ephemeral`
   and produces valid JSONL with token accounting. ~22 k input tokens
   baseline; output schema constraint via `--output-schema` is supported.
   Subscription auth works without flags.
6. Local OAuth credentials confirmed present at
   `/home/jiangzhuo/.claude/.credentials.json`. The libsecret keyring is
   also installed (`secret-tool`, `gnome-keyring-daemon`); future Claude
   Code versions that move credentials into the keyring would require us
   to read via libsecret instead of the file.
7. Local Codex OAuth credentials confirmed present at
   `/home/jiangzhuo/.codex/auth.json` with schema
   `{ tokens: { id_token, access_token, refresh_token, account_id },
   last_refresh, OPENAI_API_KEY }`. `account_id` is the value of the
   `chatgpt-account-id` request header.
8. OAuth flow constants from public reverse-engineered sources
   (`claude-relay-service`):
   - Claude: auth `https://claude.ai/oauth/authorize`, token
     `https://console.anthropic.com/v1/oauth/token`, client_id
     `9d1c250a-e61b-44d9-88ed-5944d1962f5e`.
   - Codex/ChatGPT: auth `https://auth.openai.com/oauth/authorize`, token
     `https://auth.openai.com/oauth/token`, client_id
     `app_EMoamEEZ73f0CkXaXp7hrann`, scopes
     `openid profile email offline_access`, redirect_uri
     `http://localhost:1455/auth/callback`.
9. ChatGPT Codex backend API endpoint:
   `https://chatgpt.com/backend-api/codex/responses`. Requires bearer
   access_token plus `chatgpt-account-id`, plus User-Agent / originator /
   session_id / `instructions`-prefix impersonation as documented in the
   Mode C′ section.
10. Gemini CLI is **not installed** on this machine, so live validation
    of Gemini summary modes is deferred. Documented mode parameters come
    from `claude-relay-service` Gemini support and the public
    `google-gemini/gemini-cli` repository. Confirmed that gemini-cli has
    a hooks system (events `SessionStart`, `SessionEnd`, `BeforeAgent`,
    `AfterAgent`, `BeforeModel`, `AfterModel`, `BeforeToolSelection`,
    `BeforeTool`, `AfterTool`, `PreCompress`, `Notification`) configured
    via `settings.json`, with `gemini hooks migrate --from-claude` for
    Claude Code config translation. The Gemini event vocabulary is a
    superset of Claude's; Sesshin's hook handler maps Gemini event
    names to Sesshin's normalized vocabulary (see
    `docs/state-machine.md`).

## Fallback (heuristic, when both the direct and subprocess modes fail)

If neither the direct-API mode (B′ / C′) nor the subprocess mode (B / C)
can produce a summary:

- The summary is replaced by a degraded auto-summary:
  - `oneLine` = last non-empty PTY line, ANSI stripped, truncated.
  - `bullets` = previous 4 non-empty PTY lines.
  - `needsDecision` = false (we cannot determine this without a model).
  - `suggestedNext` = null.
- A `session.attention` event is fired with severity `warning` and reason
  `summarizer-failed`, so the user knows the smart summary is missing.
- After three consecutive failures within 10 minutes for a session,
  summarization is disabled for that session and the user is asked, via
  attention notification, to configure summarization explicitly.

## Cost discipline

- Sesshin's own prompt budget: ≤ 2 k tokens of summary-relevant content per
  call (previous summary + new events). Output capped at 250 tokens.
- One summary per `Stop` event. No retries on success.
- Stall summaries rate-limited to one per 5 minutes per session.
- The agent CLI may add a large invariant system context regardless of the
  summary-relevant payload size: ~80 k tokens for `claude -p`, ~22 k for
  `codex exec --ignore-user-config --ignore-rules`. Mode B′ skips that
  context entirely, which is its main quota advantage.
- Per-call quota expectations on subscription:
  - Mode B′ (Claude direct): ~2 k tokens against weekly quota. 200 turns
    ≈ 400 k tokens.
  - Mode B (Claude subprocess, cached): ~50 k tokens. 200 turns ≈ 10 M
    tokens; likely exhausts the quota. Fallback only.
  - Mode C′ (Codex direct): ~2 k tokens against ChatGPT quota.
  - Mode C (Codex subprocess): ~22 k tokens. ~10× worse than C′.
  - Mode G′ (Gemini direct): ~2 k tokens against Code Assist quota,
    ~50-200 ms latency. Default.
  - Mode G (Gemini subprocess, verified): ~11 k tokens cold, ~3 k tokens
    warm; ~5 s latency. Fallback only.
- Sesshin tracks per-session and per-day quota usage and emits an
  attention event when daily token consumption crosses a user-configurable
  threshold (default 1 M tokens/day).

## Output schema

(See `protocol.md` `session.summary` for the wire format. The schema below
is the boundary between the summarizer and the rest of the hub.)

```ts
type Summary = {
  summaryId: string
  oneLine: string             // <= 100 chars
  bullets: string[]            // 0..5 items, each <= 80 chars
  needsDecision: boolean
  suggestedNext: string | null // shown as a quick-action label when present
  since: string | null         // previous summaryId
  generatedAt: number          // unix ms
  generatorModel: string       // e.g. "claude-haiku-4-5"
}
```

## Open questions for v1

- How to deduplicate "the same question repeated by the user" so we don't
  produce redundant `needsDecision` summaries every turn? Tentatively: the
  summarizer is allowed to include an `unchanged: true` flag and clients
  should treat unchanged summaries as suppressed.
- Whether to expose a "force re-summarize" upstream message for adapters
  (e.g. Telegram `/again`). Tentatively yes; trivially mappable.
- Whether stall summaries should be a different message type
  (`session.heartbeat-summary`) rather than a regular `session.summary`. v1
  treats them identically; revisit if clients need to suppress them
  separately.
- Mode C′ implementation requires testing the exact request body shape
  expected by `https://chatgpt.com/backend-api/codex/responses`. The
  Responses API field names (`model`, `instructions`, `input`, ...) are
  documented in `claude-relay-service` source but worth confirming with a
  recorded call from the real Codex CLI before relying on them.
- Mode G subprocess is empirically validated; Mode G′ (direct API)
  needs the same kind of HTTPS capture that's still pending for
  Mode C′. Open subquestions:
  - Exact `v1internal:generateContent` endpoint URL
    (`cloudcode-pa.googleapis.com` vs another host) and full request
    body shape — capture a real Gemini CLI HTTPS call via mitmproxy
    to confirm before shipping.
  - Whether free-tier OAuth users without a Google Cloud project hit
    the same `cloudaicompanionProject` check or are auto-provisioned
    by the Code Assist service.
- For Mode G the `--system-prompt` style override does not exist on
  `gemini --help`; the summarizer prompt must be passed in the `-p`
  argument body itself. Without an override flag, the prompt must
  explicitly tell the model to ignore the bundled coding-assistant
  persona.
