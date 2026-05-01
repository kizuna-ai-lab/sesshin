#!/usr/bin/env node
// Mode G′ prototype: call the Gemini Cloud Code Assist API directly using
// the OAuth tokens that gemini-cli already stores at
// ~/.gemini/oauth_creds.json.
//
// Compare against `gemini -p` baseline (Mode G):
//   → ~10.7k input tokens cold, ~2.9k warm cache, ~5s latency.
//
// Expectation here:
//   → ~50-150 input tokens, <2s latency, clean Chinese summary.

import { readFile, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";

const CREDS_PATH = join(homedir(), ".gemini", "oauth_creds.json");
const TOKEN_REFRESH_URL = "https://oauth2.googleapis.com/token";
const CODE_ASSIST_HOST = "https://cloudcode-pa.googleapis.com";
const LOAD_URL = `${CODE_ASSIST_HOST}/v1internal:loadCodeAssist`;
const GEN_URL = `${CODE_ASSIST_HOST}/v1internal:generateContent`;
const GEMINI_CLI_VERSION = "0.40.1";
const REFRESH_BUFFER_MS = 60_000;

// gemini-cli's embedded public OAuth client_id and client_secret.
// These are the same across every gemini-cli installation — they identify
// the gemini-cli application, not the user. Despite being called a
// "client_secret" in the OAuth spec, the value is shipped to every user
// in the gemini-cli npm package. We do NOT commit them here to avoid
// tripping secret scanners; production code should read them from the
// installed gemini-cli at runtime, or take them from environment
// variables. For local prototype runs, set:
//   SESSHIN_GEMINI_OAUTH_CLIENT_ID=...
//   SESSHIN_GEMINI_OAUTH_CLIENT_SECRET=...
// before invoking this script. Find the values inside the installed
// gemini-cli's source (search for "GOCSPX-" in node_modules).
const OAUTH_CLIENT_ID = process.env.SESSHIN_GEMINI_OAUTH_CLIENT_ID ?? "";
const OAUTH_CLIENT_SECRET = process.env.SESSHIN_GEMINI_OAUTH_CLIENT_SECRET ?? "";

const PROMPT = process.argv[2] ?? "我的心情不好";
const MODEL = process.argv[3] ?? "gemini-2.5-flash";

function userAgent() {
  return `GeminiCLI/${GEMINI_CLI_VERSION}/${MODEL} (${process.platform}; ${process.arch}; gemini-cli)`;
}

async function loadCreds() {
  const raw = await readFile(CREDS_PATH, "utf-8");
  const parsed = JSON.parse(raw);
  if (!parsed.access_token) throw new Error("oauth_creds.json missing access_token");
  return parsed;
}

async function atomicWrite(path, content) {
  const tmp = path + ".tmp." + process.pid;
  await writeFile(tmp, content, { mode: 0o600 });
  await rename(tmp, path);
}

async function refreshIfNeeded(creds) {
  const now = Date.now();
  const msUntilExpiry = creds.expiry_date - now;
  console.log(`access_token expires in ${(msUntilExpiry / 60000).toFixed(1)} min`);
  if (msUntilExpiry > REFRESH_BUFFER_MS) {
    console.log("token still fresh, skipping refresh");
    return creds.access_token;
  }
  console.log("token near expiry, refreshing...");
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: OAUTH_CLIENT_ID,
    client_secret: OAUTH_CLIENT_SECRET,
    refresh_token: creds.refresh_token,
  });
  const r = await fetch(TOKEN_REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!r.ok) {
    throw new Error(`refresh failed: ${r.status} ${await r.text()}`);
  }
  const j = await r.json();
  console.log("refresh succeeded; expires_in=", j.expires_in);
  const updated = {
    ...creds,
    access_token: j.access_token,
    expiry_date: Date.now() + (j.expires_in ?? 3600) * 1000,
    id_token: j.id_token ?? creds.id_token,
  };
  await atomicWrite(CREDS_PATH, JSON.stringify(updated, null, 2));
  return j.access_token;
}

async function loadCodeAssist(accessToken) {
  const body = {
    metadata: {
      ideType: "IDE_UNSPECIFIED",
      platform: process.platform === "linux" ? "LINUX_AMD64" : "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
      pluginVersion: GEMINI_CLI_VERSION,
    },
  };
  console.log("\n--- POST :loadCodeAssist ---");
  const t0 = performance.now();
  const r = await fetch(LOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": userAgent(),
    },
    body: JSON.stringify(body),
  });
  const dt = performance.now() - t0;
  const text = await r.text();
  console.log(`status=${r.status}  latency=${dt.toFixed(0)}ms`);
  if (!r.ok) {
    console.log("error:", text.slice(0, 800));
    throw new Error(`loadCodeAssist failed: ${r.status}`);
  }
  const j = JSON.parse(text);
  console.log("currentTier:", j.currentTier?.name ?? j.currentTier?.id ?? "(none)");
  console.log("cloudaicompanionProject:", j.cloudaicompanionProject ?? "(none)");
  return j;
}

async function generateContent(accessToken, projectId) {
  const body = {
    model: MODEL,
    user_prompt_id: randomUUID(),
    ...(projectId ? { project: projectId } : {}),
    request: {
      contents: [
        { role: "user", parts: [{ text: PROMPT }] },
      ],
      systemInstruction: {
        role: "user",
        parts: [
          {
            text:
              "You are operating as a terse summarizer for an ambient awareness " +
              "system. Reply in one short Chinese sentence. Do not call any tool. " +
              "Do not output anything other than the sentence.",
          },
        ],
      },
      generationConfig: {
        maxOutputTokens: 250,
        temperature: 0.7,
        // Suppress Gemini 2.5's internal "thoughts" tokens — for short
        // ambient summaries we don't want 240 reasoning tokens for a
        // 3-token answer.
        thinkingConfig: { thinkingBudget: 0 },
      },
      session_id: randomUUID(),
    },
  };
  console.log("\n--- POST :generateContent ---");
  const t0 = performance.now();
  const r = await fetch(GEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": userAgent(),
    },
    body: JSON.stringify(body),
  });
  const dt = performance.now() - t0;
  const text = await r.text();
  console.log(`status=${r.status}  latency=${dt.toFixed(0)}ms`);
  if (!r.ok) {
    console.log("error:", text.slice(0, 1200));
    throw new Error(`generateContent failed: ${r.status}`);
  }
  return { json: JSON.parse(text), latencyMs: dt };
}

function extractText(genJson) {
  // Code Assist responses wrap the standard Gemini response:
  //   { response: { candidates: [...], usageMetadata: {...} } }
  // or sometimes flat at top level. Handle both.
  const inner = genJson.response ?? genJson;
  const text = (inner.candidates ?? [])
    .flatMap((c) => c.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("");
  return { text, usage: inner.usageMetadata };
}

(async () => {
  console.log(`prompt: ${JSON.stringify(PROMPT)}`);
  console.log(`model:  ${MODEL}`);
  console.log(`UA:     ${userAgent()}`);
  console.log("");

  const creds = await loadCreds();
  console.log("scope:", creds.scope);
  console.log("token_type:", creds.token_type);

  const accessToken = await refreshIfNeeded(creds);
  const loaded = await loadCodeAssist(accessToken);
  const projectId = loaded.cloudaicompanionProject || undefined;

  const { json, latencyMs } = await generateContent(accessToken, projectId);

  console.log("");
  console.log("=== response ===");
  console.log("latency (ms):", latencyMs.toFixed(0));
  const { text, usage } = extractText(json);
  console.log("usage:       ", JSON.stringify(usage));
  console.log("text:");
  console.log(text || "(empty — raw json:)");
  if (!text) console.log(JSON.stringify(json, null, 2).slice(0, 1500));
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
