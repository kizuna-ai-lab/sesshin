# Validation log

Empirical results from running real CLIs on the user's machine on
**2026-05-01**, captured before scaffolding v1 code.

## 1. Claude `-p` baseline (subscription, no flags)

Command:
```
claude -p --model claude-haiku-4-5 --output-format json '我的心情不好'
```

First call result fields (truncated):
```
total_cost_usd: 0.10232375
duration_ms: 6422
input_tokens: 10
cache_creation_input_tokens: 80751
cache_read_input_tokens: 0
output_tokens: 275
session_id: ce7ad30f-6c51-424c-a61c-57177242c7c6
```

Observation: 80 k tokens of cache-creation context loaded for a 10-token
prompt. The reply also bled context from Claude Code's system prompt
(referenced "继续工作"), confirming that Claude Code's system role is active
even with `-p`.

## 2. Claude `-p` second call (warm cache check)

Same command. Cached state expected. Result:
```
total_cost_usd: 0.054920500000000004
cache_creation_input_tokens: 39696
cache_read_input_tokens: 41055
output_tokens: 237
session_id: 166b475d-2526-4cb3-8e37-6e55118499ec  (different from call 1)
```

Observation:
- Different `session_id` confirms each invocation is an independent
  conversation; parent Claude Code session is not contaminated.
- Cache hit ~50%: ~41 k cached, ~40 k re-created. Roughly half of the
  Claude Code system context is dynamic per call.
- Cost halved, not dropped 10x. This bounds Mode B's best case at ~$0.05
  per call as reported.

## 3. Claude `-p --system-prompt` override

```
claude -p --model claude-haiku-4-5 --output-format json \
  --system-prompt "Return only one short Chinese sentence." \
  '我的心情不好'
```

Result:
```
total_cost_usd: 0.09397625000000001
cache_creation_input_tokens: 74577
cache_read_input_tokens: 0
output_tokens: 149
```

Observation: `--system-prompt` does **not** strip Claude Code's bundled
context. 74 k tokens of cache-creation still loaded; cost equivalent to
cold call. `--system-prompt` augments rather than replaces.

## 4. Claude `-p --bare` (requires API key)

```
claude -p --bare --model claude-haiku-4-5 --output-format json \
  --tools "" --no-session-persistence \
  --system-prompt "Reply in one short Chinese sentence. Output nothing else." \
  '我的心情不好'
```

Result:
```
result: "Not logged in · Please run /login"
is_error: true
duration_ms: 37
```

Observation: `--bare` requires `ANTHROPIC_API_KEY` (or `apiKeyHelper`).
OAuth/subscription users cannot use this path. Per the user's direction,
the API-key path (Mode A) is dropped entirely from v1 design.

## 5. Codex `exec` baseline

```
codex exec --ignore-user-config --ignore-rules --ephemeral \
  --skip-git-repo-check --sandbox read-only --json \
  '用一句简短的中文回答：我的心情不好'
```

Result (JSONL events):
```
{"type":"thread.started","thread_id":"019de01f-..."}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"抱抱你，先别急，慢慢呼吸一下。"}}
{"type":"turn.completed","usage":{"input_tokens":21797,"cached_input_tokens":6528,"output_tokens":18}}
```

Observation:
- Subscription auth works, no flags needed.
- ~22 k input tokens baseline, ~30% caches.
- Output schema can be constrained via `--output-schema`; not tested in
  this run but documented in `codex exec --help`.
- Final answer location: `item.completed.item.text`. Tokens in
  `turn.completed.usage`.

## 6. Local credential inspection (read-only)

```
ls -la ~/.claude/.credentials.json
which secret-tool gnome-keyring-daemon
```

Confirmed:
- `/home/jiangzhuo/.claude/.credentials.json` exists.
- `secret-tool` and `gnome-keyring-daemon` are installed; future Claude
  Code versions that move credentials into the keyring would require
  reading via libsecret instead of from the file.
- Contents not opened during validation; the public OAuth flow
  documentation in `claude-relay-service` describes the schema
  (`accessToken`, `refreshToken`, `expiresAt`, `scopes`).

## 6b. Local Codex credential schema (structural inspection)

Confirmed structure (values redacted; only key shapes shown):

```json
{
  "OPENAI_API_KEY": null,
  "tokens": {
    "id_token":      "<JWT, ~2057 chars>",
    "access_token":  "<bearer, ~1883 chars>",
    "refresh_token": "<~90 chars>",
    "account_id":    "<UUID, 36 chars>"
  },
  "last_refresh":    "<ISO timestamp, 30 chars>"
}
```

Implications:
- `tokens.access_token` is the Bearer for direct API calls.
- `tokens.refresh_token` is used at
  `https://auth.openai.com/oauth/token` (POST, `grant_type=refresh_token`,
  `client_id=app_EMoamEEZ73f0CkXaXp7hrann`).
- `tokens.account_id` is the `chatgpt-account-id` request header value.
- `OPENAI_API_KEY` is `null` for OAuth-subscription users; if non-null,
  the user is on the API-key path and Mode C′ is unnecessary.
- `last_refresh` lets us compute whether the access token is near
  expiry without decoding the JWT.

## 7. Help output excerpts (kept for reference)

Selected flags from `claude --help` relevant to summarizer:

- `--bare` — minimal mode; skips hooks, LSP, plugin sync, auto-memory,
  keychain, CLAUDE.md auto-discovery; auth strictly via
  `ANTHROPIC_API_KEY`.
- `--tools ""` — disable all tools.
- `--no-session-persistence` — do not save the session to disk.
- `--exclude-dynamic-system-prompt-sections` — improves cache reuse by
  moving cwd/env/git into first user message.
- `--max-budget-usd <amount>` — built-in dollar cap (only with `--print`).
- `--system-prompt <prompt>` — augments the default system prompt; does
  not replace it.

Selected flags from `codex exec --help` relevant to summarizer:

- `--ignore-user-config` — do not load `~/.codex/config.toml` (drops MCP
  servers and profiles).
- `--ignore-rules` — drop user/project execpolicy `.rules` files.
- `--ephemeral` — do not persist session files to disk.
- `--output-schema <FILE>` — constrain the model output to a JSON Schema.
- `--json` — print events as JSONL.
- `-m, --model <MODEL>` — model selection.

## 8. Gemini CLI empirical validation (added 2026-05-02)

gemini-cli installed on this machine. Verified version: **0.40.1**, at
`/home/jiangzhuo/.nvm/versions/node/v24.3.0/bin/gemini`.

### Local config layout (corrects earlier deferred guess)

`~/.gemini/` contents (NOT `~/.config/.gemini/` — that path was wrong):

- `oauth_creds.json` (mode 0600) — OAuth credentials.
- `google_accounts.json` — `{ active: <email>, old: [...] }`. Account
  selector.
- `settings.json` — `{ "security": { "auth": { "selectedType": "oauth-personal" } } }`
  in the default install. Hooks would be added here under `hooks`.
- `state.json`, `projects.json`, `installation_id`, `trustedFolders.json`,
  `history/`, `tmp/`.

`oauth_creds.json` schema (verified non-invasively, no values printed):

```text
{
  "access_token":  "<~258 chars>",
  "refresh_token": "<~103 chars>",
  "scope":         "<~149 chars; space-separated>",
  "token_type":    "Bearer",
  "id_token":      "<JWT, ~1149 chars>",
  "expiry_date":   <unix epoch in ms, integer>
}
```

### `gemini --help` excerpt (relevant flags)

- `-p, --prompt` — non-interactive headless mode.
- `-o, --output-format` — `text` / `json` / `stream-json`.
- `-m, --model` — model selection (e.g. `gemini-2.5-flash`).
- `-e, --extensions` — list of extensions; pass `''` to disable all
  (no GEMINI.md auto-load, no MCP, no skills).
- `--skip-trust` — bypass the trusted-folders check (required for
  non-interactive use in untrusted dirs).
- `--allowed-mcp-server-names` — MCP server allowlist.
- `--policy` / `--admin-policy` — policy engine config.
- No `--system-prompt` flag exists; system prompt is set via
  GEMINI.md (which `-e ''` disables) or settings.

`gemini hooks` subcommand has only one verb: `migrate` (Claude → Gemini
config translation). Hooks are configured by editing `settings.json`
directly.

### Empirical `gemini -p` results

```
cd /tmp && gemini -p '用一句简短的中文回答：我的心情不好' \
  -o json --skip-trust -e ''
```

| Run | Model | Input tokens | Output (cand+thoughts) | Latency | Notes |
|-----|-------|-------------:|----------------------:|--------:|-------|
| 1 (cold) | `gemini-3-flash-preview` (default) | 10,714 | 17 + 610 | 4.8 s API | response bled coding-assistant tone |
| 2 (warm) | `gemini-3-flash-preview` | **2,853** | similar | 8.4 s wall | cache reuse confirmed |
| 3 | `gemini-2.5-flash` (-m) | 8,471 | similar | 4.2 s | smaller bundled context for older model |

JSON output structure (relevant fields):

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
    },
    "tools": { "totalCalls": 0, ... },
    "files": { "totalLinesAdded": 0, "totalLinesRemoved": 0 }
  }
}
```

### Implications

- Gemini's bundled context overhead is **~10× smaller than Claude's
  (80 k) and ~7× smaller than Codex's (22 k)**. Subprocess Mode G is
  acceptable as v1's primary Gemini path; Mode G′ becomes a v1.5
  latency optimization rather than a cost necessity.
- Cache reuse (~3 k warm) is automatic without flags.
- `-e ''` is the equivalent of `claude --bare` / `codex exec
  --ignore-user-config` for dropping extension/skill/MCP context.
- The output schema is reliable JSON; `stats.models.<model>.tokens`
  gives Sesshin everything it needs for quota tracking.
- Gemini has no `--system-prompt` flag; Sesshin's summarizer prompt
  must be passed in the `-p` argument body itself.

## 9. Mode B′ end-to-end prototype (added 2026-05-02)

A 130-line Node script at `prototypes/mode-b-prime.mjs` reads OAuth
tokens from `~/.claude/.credentials.json` and calls
`https://api.anthropic.com/v1/messages?beta=true` directly. Run three
times on the user's actual Max-tier subscription:

```
prompt: "我的心情不好"
→ status=200, latency=1496ms, input_tokens=65, output_tokens=16
→ text: 希望你很快能感到好一些。

prompt: "我的心情不好"  (second run)
→ status=200, latency=1067ms, input_tokens=65, output_tokens=16
→ text: 希望你很快能感到好一些。

prompt: "简短总结：用户已经迁移了 7/12 个端点，2 个测试失败"
→ status=200, latency=916ms, input_tokens=88, output_tokens=29
→ text: 用户已完成七分之十二的端点迁移，但两个测试失败。
```

Comparison with the Mode B subprocess baseline from Section 1/2:

| Metric | Mode B (`claude -p` warm) | Mode B′ (direct API) |
|---|---:|---:|
| Latency | ~6.4 s | **0.9-1.5 s** |
| Input tokens | ~50 k after cache hit | **65-88** |
| Output tokens | ~250 | 16-29 |
| Quality | bled coding-assistant tone | clean, terse, on-prompt |

Quota burn improvement: ~600× lower input tokens. Latency improvement:
~5× lower.

### Header recipe (verified working)

```
Authorization: Bearer <accessToken from claudeAiOauth.accessToken>
anthropic-version: 2023-06-01
anthropic-beta: oauth-2025-04-20
anthropic-dangerous-direct-browser-access: true
x-app: cli
User-Agent: claude-cli/<version> (external, cli)
Content-Type: application/json
Accept: application/json
Accept-Encoding: identity
```

Without `anthropic-beta: oauth-2025-04-20`, Anthropic returns
`401 OAuth authentication is currently not supported.`

### Body recipe (verified working)

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
  "metadata": { "user_id": "user_<8 random hex bytes>_account__session_<16 random hex bytes>" }
}
```

The first system block — the literal string
`You are Claude Code, Anthropic's official CLI for Claude.` — is
required. Omitting it or replacing it produces 401 even with the
correct beta header. The second block carries Sesshin's actual
summarizer instructions; the first block is cached so it amortizes.

`metadata.user_id` was accepted with random hex values. We did not
attempt to discover whether Anthropic validates the format more
strictly under heavy use; if it does, we'd source the user portion
from the JWT subject claim in the credentials file.

### Local credentials file layout (corrects earlier guess)

`~/.claude/.credentials.json` actual schema (root has a wrapper key):

```text
{
  "claudeAiOauth": {
    "accessToken":      "<108 chars>",
    "refreshToken":     "<108 chars>",
    "expiresAt":        <unix epoch ms>,
    "scopes":           ["user:file_upload", "user:inference",
                         "user:mcp_servers", "user:profile",
                         "user:sessions:claude_code"],
    "subscriptionType": "max" | "pro" | ...,
    "rateLimitTier":    "default_claude_max_5x" | ...
  },
  "mcpOAuth":           { /* per-MCP-server OAuth state, not relevant */ }
}
```

Implementation must read `claudeAiOauth.accessToken` (NOT `accessToken`
at root). The earlier docs and the public claude-relay-service guess
both flat-named the fields; the actual on-disk file wraps them. This is
a load-bearing detail for v1's credentials reader.

### Conclusion

Mode B′ is fully validated. The design's load-bearing claim (direct
OAuth API call works for personal Claude.ai subscriptions) is now
empirically true on the actual user's machine.

## 10. Mode C′ end-to-end prototype (added 2026-05-02)

A 200-line Node script at `prototypes/mode-c-prime.mjs` reads OAuth
tokens from `~/.codex/auth.json` and calls
`https://chatgpt.com/backend-api/codex/responses` directly with
`stream: true`, parses the SSE event stream, extracts the final text
and usage. Three successful runs on the user's actual ChatGPT account:

```
prompt: "我的心情不好"  model: gpt-5.4-mini
→ status=200, ttfb=739ms, total=2034ms, input=60, output=27
→ text: 抱抱你，愿意的话可以告诉我发生了什么，我陪你一起慢慢理一理。

prompt: "我的心情不好"  (second run)
→ status=200, ttfb=662ms, total=1645ms, input=60, output=30
→ text: 听起来你现在很难受，先慢慢呼吸一下，如果愿意可以跟我说说发生了什么。

prompt: "简短总结：用户已经迁移了 7/12 个端点，2 个测试失败"
→ status=200, ttfb=956ms, total=1506ms, input=77, output=24
→ text: 用户已迁移 7/12 个端点，且有 2 个测试失败。
```

One transient 503 ("upstream connect error or disconnect/reset before
headers") in between successful calls — production code needs retry
logic for these.

Comparison with Mode C subprocess baseline:

| Metric | Mode C (`codex exec`) | Mode C′ (direct) |
|---|---:|---:|
| Latency total | ~5 s | **1.5-2.0 s** |
| TTFB | n/a (subprocess startup) | 660-960 ms |
| Input tokens | ~22,000 | **60-77** |
| Output tokens | ~18 | 24-30 |

Quota burn improvement: ~370× lower input tokens.

### Findings that contradict / refine the design docs

1. `/compact` is **not** a non-streaming chat endpoint — it's a
   conversation compaction endpoint that produces an
   `encrypted_content` summary, unsuitable for our use. The earlier
   docs hinted at `/compact` as the non-streaming variant; that
   guess was wrong.
2. `/responses` requires `stream: true`. There is no non-streaming
   chat endpoint for ChatGPT-account users. v1 implementation MUST
   parse SSE.
3. ChatGPT-account-eligible models are NOT the standard
   `gpt-5-mini` / `gpt-4o-mini` / etc. names. They are
   version-prefixed and listed by a separate API call:
   `GET https://chatgpt.com/backend-api/codex/models?client_version=<v>`.
   On 2026-05-02 the list was: `gpt-5.5`, `gpt-5.4`,
   `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.2`, `codex-auto-review`.
   Sesshin must call this endpoint at least once to discover model
   availability and cache the result (codex-cli itself does this and
   caches in `~/.codex/models_cache.json` with a 5-minute TTL).
4. The `id_token` JWT in `auth.json` may show as long-expired even
   while the `access_token` is fresh — they're separate tokens with
   independent lifetimes. Sesshin's refresh logic must check
   `access_token` expiry, not `id_token`.

### Header recipe (verified working)

```
Authorization: Bearer <access_token from tokens.access_token>
chatgpt-account-id: <tokens.account_id>
Accept: text/event-stream
Content-Type: application/json
User-Agent: codex_cli_rs/<version>     (must match /^(codex_vscode|codex_cli_rs|codex_exec)\/[\d.]+/)
originator: codex_cli_rs               (must match the User-Agent client kind)
session_id: <UUID v4>
```

Optional but tolerated: `version`, `openai-beta`. Not required for
basic call.

### Body recipe (verified working)

```text
{
  "model": "gpt-5.4-mini",
  "instructions": "You are Codex, based on GPT-5. You are running as a coding agent in the Codex CLI. <sesshin instructions>",
  "input": [
    { "type": "message", "role": "user",
      "content": [{ "type": "input_text", "text": "<prompt body>" }] }
  ],
  "stream": true,
  "store": false
}
```

Server-side requirements:
- `instructions` MUST start with the literal string
  `You are Codex, based on GPT-5. You are running as a coding agent
  in the Codex CLI` — same impersonation pattern as Claude's "You
  are Claude Code".
- `input` items use `content[].type = "input_text"` (not just
  `text` like Anthropic uses).
- `stream` MUST be true.
- `store: false` to disable conversation storage on the backend.

### SSE parsing

Events to handle:

- `event: response.output_text.delta`, `data: { delta, ... }` —
  accumulate `delta` for streaming display.
- `event: response.completed`, `data: { response: { output, usage,
  ... } }` — final state including `usage.input_tokens`,
  `usage.output_tokens`, `usage.total_tokens`,
  `usage.input_tokens_details.cached_tokens`,
  `usage.output_tokens_details.reasoning_tokens`.
- Other events (`response.created`, `response.in_progress`,
  `response.output_item.added`, etc.) can be ignored for v1
  summarizer.

Sesshin's summarizer ignores deltas and waits for `response.completed`
since it returns a single object back to clients anyway, but a
debug-web client may want the deltas for streaming display.

### Refresh flow (not exercised on this run)

The `id_token` JWT showed expiry 6 days in the past, but the
`access_token` JWT was still fresh (3.8 days remaining). Codex CLI
manages these independently. Refresh recipe per `claude-relay-service`:

```
POST https://auth.openai.com/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&client_id=app_EMoamEEZ73f0CkXaXp7hrann
&refresh_token=<tokens.refresh_token>
&scope=openid profile email
```

Response: `{ access_token, id_token, refresh_token, expires_in }`. The
prototype's refresh path is implemented but untested in this session.

## 11. Mode G′ end-to-end prototype (added 2026-05-02)

A 215-line Node script at `prototypes/mode-g-prime.mjs` reads OAuth
tokens from `~/.gemini/oauth_creds.json`, refreshes if needed via
`https://oauth2.googleapis.com/token`, calls `:loadCodeAssist` to
discover/provision a project for free-tier users, then
`:generateContent` for the actual summary.

```
Run 1 (thinking enabled):
  loadCodeAssist: 1604ms → cloudaicompanionProject: upbeat-portfolio-1frtp
  generateContent: 3573ms
  usage: {prompt:39, candidates:3, thoughts:240, total:282}
  text: "抱歉。"

Run 2 (thinkingBudget: 0):
  loadCodeAssist: 1343ms (could be cached)
  generateContent: 1263ms
  usage: {prompt:39, candidates:4, total:43}
  text: "你心情不好。"

Run 3 (different prompt):
  generateContent: returned 429 with 808ms retry delay (free tier limit)

Run 3 retry (after sleep 3s):
  loadCodeAssist: 831ms
  generateContent: 2031ms
  usage: {prompt:57, candidates:17, total:74}
  text: "用户已迁移7/12个端点，其中2个测试失败。"
```

Comparison with Mode G subprocess baseline (Section 8):

| Metric | Mode G (`gemini -p` warm) | Mode G′ (direct) |
|---|---:|---:|
| Latency | ~5 s | **1.3-2.0 s** (gen) + ~1 s (one-time loadCodeAssist) |
| Input tokens | ~2,900 | **39-57** |
| Output (no thoughts) | ~17 | 4-17 |

Quota burn improvement: ~50-75× lower input tokens.

### Findings

1. **Free-tier OAuth users are auto-provisioned a project** by
   `:loadCodeAssist`. The response carries
   `cloudaicompanionProject: <auto-generated id>` (e.g.
   `upbeat-portfolio-1frtp`). Cache this and reuse for subsequent
   `:generateContent` calls within the session — avoids the ~1 s
   loadCodeAssist round-trip per call.
2. **`thinkingConfig: { thinkingBudget: 0 }` is essential** for ambient
   summaries on Gemini 2.5. Without it, the model emits 200+
   "thoughts" tokens for trivial outputs, tripling latency and
   consuming quota without contributing visible value.
3. **Free-tier 429s** happen on rapid-fire calls. The error body
   includes `RetryInfo.retryDelay` (e.g. `0.808s`) — production code
   must honor it. Sesshin's 1-summary-per-Stop-event cadence is
   unlikely to trip this in normal use.
4. **Refresh flow works end-to-end.** When `expiry_date` was 8.9 min
   in the past, the prototype refreshed via the standard OAuth token
   endpoint (`oauth2.googleapis.com/token`, with both `client_id`
   and `client_secret` — Google requires the secret here, unlike
   Anthropic and OpenAI which accept just the public client_id).
   The refreshed creds were written back to
   `~/.gemini/oauth_creds.json` atomically (temp + rename, mode 0600
   preserved).
5. **No magic prompt prefix required.** Unlike Claude's "You are
   Claude Code" or Codex's "You are Codex, based on GPT-5", Gemini's
   Code Assist accepts arbitrary `systemInstruction.parts[].text`.
   The body itself is the impersonation; the User-Agent is the
   secondary check.

### Header recipe (verified working)

```
Authorization: Bearer <access_token>
Content-Type: application/json
User-Agent: GeminiCLI/<version>/<model> (<platform>; <arch>; gemini-cli)
```

That's it — no x-goog-* headers required by default. (Optional:
`x-gemini-api-privileged-user-id: <installation_id>` if usage
telemetry is enabled in gemini-cli; not needed for our use.)

### Body recipe (verified working, gemini-cli source confirmed)

`:loadCodeAssist`:
```text
{
  "metadata": {
    "ideType": "IDE_UNSPECIFIED",
    "platform": "LINUX_AMD64" | "DARWIN_AMD64" | ...,
    "pluginType": "GEMINI",
    "pluginVersion": "<gemini-cli version>"
  }
  // optionally: "cloudaicompanionProject": "<id>" if the caller
  // already knows one
}
```

Response: `{ currentTier, allowedTiers, ineligibleTiers,
cloudaicompanionProject, paidTier }`. Cache the
`cloudaicompanionProject` value.

`:generateContent` (the schema is `CAGenerateContentRequest` from
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

Response is wrapped: top level `{ response: { candidates, usageMetadata } }`
or sometimes flat `{ candidates, usageMetadata }`. Production code
should handle both.

Text at `response.candidates[].content.parts[].text`. Usage at
`response.usageMetadata.{promptTokenCount, candidatesTokenCount,
totalTokenCount, thoughtsTokenCount}`.

### Refresh recipe (verified working)

```
POST https://oauth2.googleapis.com/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&client_id=<gemini-cli's embedded OAuth client_id>
&client_secret=<gemini-cli's embedded OAuth client_secret>
&refresh_token=<oauth_creds.refresh_token>
```

Response: `{ access_token, expires_in, scope, token_type, id_token? }`.
Compute new `expiry_date = Date.now() + expires_in*1000` and write
back to `~/.gemini/oauth_creds.json` atomically.

The client_id and client_secret are the public OAuth client embedded
in every gemini-cli build (not user-specific secrets — every install
has the same values). Google requires the secret here even though
most public OAuth flows omit it. The literal values are not committed
to this repo to avoid tripping automated secret scanners; they can
be extracted from the installed `gemini-cli` package at runtime
(grep for `GOCSPX-` inside its `node_modules`).

## Decisions locked in by these results

- **Claude Code summarization defaults to Mode B′** (direct OAuth API
  call to `https://api.anthropic.com/v1/messages?beta=true`) for cost
  and latency reasons. Mode B (subprocess) is fallback. Mode A (API key)
  is dropped per user instruction.
- **Codex summarization defaults to Mode C′** (direct OAuth API call to
  `https://chatgpt.com/backend-api/codex/responses`) for the same
  reasons. Mode C (subprocess `codex exec`) is fallback. Both modes
  require User-Agent / originator / session_id / `instructions`-prefix
  impersonation — see `docs/summarizer.md`.
- **Gemini summarization defaults to Mode G′** (direct OAuth API call
  to Code Assist `https://cloudcode-pa.googleapis.com/v1internal:generateContent`)
  when OAuth credentials are present, matching the uniform "direct-API
  default, subprocess fallback" pattern used for Claude (B′/B) and
  Codex (C′/C). Mode G (`gemini -p -o json --skip-trust -e '' -m
  gemini-2.5-flash '<body>'`) is fallback. v1 considers only
  OAuth/subscription users for all three agents; separate API-key
  paths are out of scope. The Mode G empirical numbers above bound
  the fallback's behavior and confirm it is genuinely usable rather
  than a degraded mode of last resort.
- **Hook event vocabulary is normalized** at the handler level. Claude
  and Codex events pass through; Gemini events are renamed
  (`BeforeAgent`→`UserPromptSubmit`, `AfterAgent`→`Stop`,
  `BeforeTool`→`PreToolUse`, `AfterTool`→`PostToolUse`). Gemini-only
  events (`BeforeModel`, etc.) are passed through as
  `agent-internal`.
- **Heuristic tail summary** is the last-resort fallback when both
  direct and subprocess modes fail repeatedly.

## 12.1 Settings-merge verification (run 2026-05-02)

Verification gate 1 (M0/T1) for the design assumption that `claude
--settings <file>` MERGES hook arrays across settings layers (the
user's `~/.claude/settings.json` plus our temp file) rather than
replacing them.

### Setup

The user's `~/.claude/settings.json` already contained `hooks` (probed
via `python3 -c "import json; d=json.load(open('/home/jiangzhuo/.claude/settings.json')); print('existing hooks?', 'hooks' in d)"`
which printed `existing hooks? True`). The file was backed up to
`~/.claude/settings.json.bak.gate1` before any modification.

A no-op user-level `Stop` hook was appended to the existing
`hooks.Stop` array (preserving the existing peon-ping Stop entry):

```json
{ "matcher": "*", "hooks": [
  { "type": "command", "command": "/bin/sh -c 'touch /tmp/sesshin-gate1-user-hook'" }
]}
```

A separate test settings file was written to
`/tmp/sesshin-gate1-test.json`:

```json
{
  "hooks": {
    "Stop": [
      { "matcher": "*", "hooks": [
        { "type": "command", "command": "/bin/sh -c 'touch /tmp/sesshin-gate1-our-hook'" }
      ]}
    ]
  }
}
```

### Commands

```
rm -f /tmp/sesshin-gate1-user-hook /tmp/sesshin-gate1-our-hook
claude -p --settings /tmp/sesshin-gate1-test.json --model claude-haiku-4-5 'reply with one word'
ls -la /tmp/sesshin-gate1-*-hook
```

### Outcome

Both sentinel files exist after the call:

```
-rw-rw-r-- 1 jiangzhuo jiangzhuo 0  5月  2 05:55 /tmp/sesshin-gate1-our-hook
-rw-rw-r-- 1 jiangzhuo jiangzhuo 0  5月  2 05:55 /tmp/sesshin-gate1-user-hook
```

Result: **MERGE**. `claude --settings <file>` merges hook arrays
across settings layers. Both the user's `~/.claude/settings.json`
hooks and the temp file's hooks fired on the single `Stop` event.

### Implication for CLI design

Sesshin's CLI can use the **simple temp-file path**: write our hooks
to a session-scoped temp settings JSON and pass it via `--settings`,
without needing a merge fallback that pre-composes the user's hooks
into the temp file. The Task 50 merge fallback is therefore
unnecessary for normal operation on this version of `claude` and can
be deferred or kept only as defensive handling against future CLI
behavior changes.

### Cleanup

Original `~/.claude/settings.json` restored from
`~/.claude/settings.json.bak.gate1` (verified: `Stop` hooks count
returned to 1, no `sesshin-gate1` marker in file, all top-level keys
preserved). Temp files (`/tmp/sesshin-gate1-test.json`,
`/tmp/sesshin-gate1-user-hook`, `/tmp/sesshin-gate1-our-hook`)
removed. The `claude -p` call consumed one Haiku invocation against
the user's Max-tier subscription; output was the single token
`Ready.`.

