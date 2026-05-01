#!/usr/bin/env node
// Mode C′ prototype: call the ChatGPT Codex backend directly using the
// OAuth tokens that Codex CLI already stores at ~/.codex/auth.json.
//
// Compare against `codex exec --ignore-user-config --ignore-rules
// --ephemeral` baseline:
//   → ~22k input tokens, ~5s latency.
//
// Expectation here:
//   → ~50-150 input tokens, <2s latency, clean Chinese summary.

import { readFile, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";

const AUTH_PATH = join(homedir(), ".codex", "auth.json");
const TOKEN_REFRESH_URL = "https://auth.openai.com/oauth/token";
const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_CLI_VERSION = "0.125.0";
const USER_AGENT = `codex_cli_rs/${CODEX_CLI_VERSION}`;
const REFRESH_BUFFER_MS = 60_000;

const PROMPT = process.argv[2] ?? "我的心情不好";
const MODEL = process.argv[3] ?? "gpt-5-codex";

async function loadAuth() {
  const raw = await readFile(AUTH_PATH, "utf-8");
  const parsed = JSON.parse(raw);
  if (!parsed.tokens) {
    throw new Error("auth.json missing tokens key");
  }
  return parsed;
}

function jwtExpiry(jwt) {
  // Decode the payload, return exp as ms.
  const [, payloadB64] = jwt.split(".");
  const json = Buffer.from(payloadB64, "base64url").toString("utf-8");
  const payload = JSON.parse(json);
  return payload.exp ? payload.exp * 1000 : 0;
}

async function atomicWrite(path, content) {
  const tmp = path + ".tmp." + process.pid;
  await writeFile(tmp, content, { mode: 0o600 });
  await rename(tmp, path);
}

async function refreshIfNeeded(auth) {
  const now = Date.now();
  const accessExp = jwtExpiry(auth.tokens.access_token);
  const msUntilExpiry = accessExp - now;
  console.log(`access_token expires in ${(msUntilExpiry / 60000).toFixed(1)} min (exp=${new Date(accessExp).toISOString()})`);
  if (msUntilExpiry > REFRESH_BUFFER_MS) {
    console.log("token still fresh, skipping refresh");
    return auth.tokens.access_token;
  }
  console.log("token expired/near-expiry, refreshing...");
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: OAUTH_CLIENT_ID,
    refresh_token: auth.tokens.refresh_token,
    scope: "openid profile email",
  });
  const r = await fetch(TOKEN_REFRESH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: params.toString(),
  });
  if (!r.ok) {
    throw new Error(`refresh failed: ${r.status} ${await r.text()}`);
  }
  const j = await r.json();
  console.log("refresh succeeded");
  console.log("  new access_token length:", j.access_token?.length);
  console.log("  expires_in:", j.expires_in, "s");
  console.log("  new refresh_token returned:", !!j.refresh_token);

  // Write back atomically so codex-cli stays in sync.
  const updated = {
    ...auth,
    tokens: {
      ...auth.tokens,
      id_token: j.id_token ?? auth.tokens.id_token,
      access_token: j.access_token,
      refresh_token: j.refresh_token ?? auth.tokens.refresh_token,
    },
    last_refresh: new Date().toISOString(),
  };
  await atomicWrite(AUTH_PATH, JSON.stringify(updated, null, 2) + "\n");
  console.log("  auth.json rewritten atomically");

  return j.access_token;
}

async function callResponses(accessToken, accountId) {
  const body = {
    model: MODEL,
    instructions:
      "You are Codex, based on GPT-5. You are running as a coding agent in the Codex CLI. " +
      "Reply in one short Chinese sentence. Do not call any tool. Do not output anything other than the sentence.",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: PROMPT }],
      },
    ],
    stream: true,
    store: false,
  };

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "chatgpt-account-id": accountId,
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
    originator: "codex_cli_rs",
    session_id: randomUUID(),
  };

  console.log("\n--- POST (streaming) ---");
  const t0 = performance.now();
  const r = await fetch(RESPONSES_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  console.log(`status=${r.status}`);
  if (!r.ok) {
    const errText = await r.text();
    console.log("error body:", errText.slice(0, 1200));
    throw new Error(`responses call failed: ${r.status}`);
  }

  // Parse SSE
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalText = "";
  let usage = null;
  let firstChunkAt = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (firstChunkAt === null) firstChunkAt = performance.now();
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const lines = block.split("\n");
      const eventName = lines.find((l) => l.startsWith("event:"))?.slice(6).trim();
      const dataLine = lines.find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const dataStr = dataLine.slice(5).trim();
      if (dataStr === "[DONE]") continue;
      try {
        const j = JSON.parse(dataStr);
        if (eventName === "response.output_text.delta" || j.type === "response.output_text.delta") {
          finalText += j.delta ?? "";
        } else if (eventName === "response.completed" || j.type === "response.completed") {
          usage = j.response?.usage ?? j.usage;
          // Some implementations put final text in response.output rather than streaming deltas.
          if (!finalText && j.response?.output) {
            for (const item of j.response.output) {
              if (item.type === "message") {
                for (const c of item.content ?? []) {
                  if (c.type === "output_text") finalText += c.text;
                }
              }
            }
          }
        }
      } catch {
        // ignore parse errors on non-JSON SSE comments / heartbeats
      }
    }
  }

  const dt = performance.now() - t0;
  const ttfb = firstChunkAt ? firstChunkAt - t0 : null;
  console.log(`first chunk: ${ttfb?.toFixed(0)}ms, total: ${dt.toFixed(0)}ms`);
  return { text: finalText, usage, latencyMs: dt, ttfbMs: ttfb };
}

(async () => {
  console.log(`prompt: ${JSON.stringify(PROMPT)}`);
  console.log(`model:  ${MODEL}`);
  console.log("");

  const auth = await loadAuth();
  console.log("account_id:", auth.tokens.account_id);
  console.log("OPENAI_API_KEY present:", auth.OPENAI_API_KEY != null);

  const accessToken = await refreshIfNeeded(auth);
  const accountId = auth.tokens.account_id;
  const { text, usage, latencyMs, ttfbMs } = await callResponses(accessToken, accountId);

  console.log("");
  console.log("=== response ===");
  console.log("ttfb (ms):   ", ttfbMs?.toFixed(0));
  console.log("total (ms):  ", latencyMs.toFixed(0));
  console.log("usage:       ", JSON.stringify(usage));
  console.log("text:");
  console.log(text || "(empty)");
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
