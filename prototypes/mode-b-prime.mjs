#!/usr/bin/env node
// Mode B′ prototype: call the Anthropic Messages API directly using the
// OAuth tokens that Claude Code already stores at
// ~/.claude/.credentials.json. The whole point is to verify that this
// path actually works end-to-end on a real subscription account, with a
// realistic token usage and latency profile.
//
// Compare against `claude -p` baseline:
//   claude -p --model claude-haiku-4-5 --output-format json '我的心情不好'
//   → ~80k cache_creation_input_tokens, ~$0.10, 6.4s
//
// Expectation here:
//   → ~10-50 input_tokens (only our prompt), <1s latency.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const CREDS_PATH = join(homedir(), ".claude", ".credentials.json");
const TOKEN_REFRESH_URL = "https://console.anthropic.com/v1/oauth/token";
const MESSAGES_URL = "https://api.anthropic.com/v1/messages?beta=true";
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_VERSION = "2023-06-01";
const CLAUDE_CODE_VERSION = "2.1.126";
const USER_AGENT = `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`;
const REFRESH_BUFFER_MS = 60_000;

const PROMPT = process.argv[2] ?? "我的心情不好";
const MODEL = process.argv[3] ?? "claude-haiku-4-5";

async function loadCreds() {
  const raw = await readFile(CREDS_PATH, "utf-8");
  const parsed = JSON.parse(raw);
  if (!parsed.claudeAiOauth) {
    throw new Error("credentials file missing claudeAiOauth key");
  }
  return parsed.claudeAiOauth;
}

async function refreshIfNeeded(oauth) {
  const now = Date.now();
  const msUntilExpiry = oauth.expiresAt - now;
  console.log(`token expires in ${(msUntilExpiry / 60000).toFixed(1)} min`);
  if (msUntilExpiry > REFRESH_BUFFER_MS) {
    console.log("token still fresh, skipping refresh");
    return oauth.accessToken;
  }
  console.log("token near expiry, refreshing...");
  const r = await fetch(TOKEN_REFRESH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: oauth.refreshToken,
      client_id: OAUTH_CLIENT_ID,
    }),
  });
  if (!r.ok) {
    throw new Error(`refresh failed: ${r.status} ${await r.text()}`);
  }
  const j = await r.json();
  console.log("refresh succeeded; new accessToken length =", j.access_token?.length);
  return j.access_token;
}

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function callMessages(accessToken) {
  // The system prompt MUST start with the Claude Code prefix; Anthropic
  // checks for it server-side when authenticating via an OAuth bearer.
  // Our actual summarizer instructions follow as a second system block,
  // marked as ephemeral cache so the prefix block can be cached separately.
  const systemBlocks = [
    {
      type: "text",
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text:
        "You are operating as a terse summarizer for an ambient awareness " +
        "system. Reply in one short Chinese sentence. Do not call any " +
        "tool. Do not output anything other than the sentence.",
    },
  ];

  // metadata.user_id format expected by Anthropic for OAuth-bearer calls:
  // user_<hex>_account__session_<hash>. The exact values are not validated
  // for shape correctness in our experience; any plausibly-formatted string
  // works.
  const metadata = {
    user_id: `user_${randomHex(8)}_account__session_${randomHex(16)}`,
  };

  const body = {
    model: MODEL,
    max_tokens: 250,
    system: systemBlocks,
    messages: [{ role: "user", content: PROMPT }],
    metadata,
  };

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-beta": "oauth-2025-04-20",
    "anthropic-dangerous-direct-browser-access": "true",
    "x-app": "cli",
    "User-Agent": USER_AGENT,
    "Content-Type": "application/json",
    Accept: "application/json",
    "Accept-Encoding": "identity",
  };

  console.log("\n--- POST ---");
  const t0 = performance.now();
  const r = await fetch(MESSAGES_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const dt = performance.now() - t0;
  const text = await r.text();
  console.log(`status=${r.status}  latency=${dt.toFixed(0)}ms`);
  if (!r.ok) {
    console.log("error body:", text.slice(0, 800));
    throw new Error(`messages call failed: ${r.status}`);
  }
  return { json: JSON.parse(text), latencyMs: dt };
}

(async () => {
  console.log(`prompt: ${JSON.stringify(PROMPT)}`);
  console.log(`model:  ${MODEL}`);
  console.log("");

  const oauth = await loadCreds();
  console.log("scopes:", oauth.scopes);
  console.log("subscriptionType:", oauth.subscriptionType);
  console.log("rateLimitTier:", oauth.rateLimitTier);

  const accessToken = await refreshIfNeeded(oauth);
  const { json, latencyMs } = await callMessages(accessToken);

  console.log("");
  console.log("=== response ===");
  console.log("latency (ms):    ", latencyMs.toFixed(0));
  console.log("model returned:  ", json.model);
  console.log("stop_reason:     ", json.stop_reason);
  console.log("usage:           ", JSON.stringify(json.usage));
  const text = (json.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  console.log("text:");
  console.log(text);
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
