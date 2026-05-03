# PermissionRequest Hook + Schema Split — Design

**Status:** Implemented (v1.5.x — worktree-permission-request, PR #1)
**Scope:** Sesshin v1.5.x — adds a real PermissionRequest approval path alongside today's PreToolUse path, with three-tier stale cleanup, and a Codex sanitizer scaffold.
**Touches:** `packages/shared`, `packages/hub`, `packages/cli`, `tests` (unit + e2e).
**Branch:** `worktree-permission-request` (worktree at `.claude/worktrees/permission-request`).

## 1. Goal

Make sesshin gate Claude Code's *real* approval path — the `PermissionRequest` HTTP hook — instead of relying solely on `PreToolUse` to derive permission decisions. The five concrete deliverables:

1. **PermissionRequest event type and approval path.** Hub accepts the native HTTP-hook payload at `POST /permission/:sessionId`; emits a `PermissionRequest` envelope onto the same event bus that consumes `PreToolUse`; runs the approval flow against the existing tool-handler registry; returns the PermissionRequest-shape decision JSON to Claude.
2. **`/hooks` keeps PreToolUse, but PermissionRequest is preferred.** A session that has been seen using PermissionRequest sticks `usesPermissionRequest = true` in the registry; from then on its PreToolUse arrivals 204-passthrough (state events still flow). Sessions on older Claude Code versions, or where the temp-file HTTP hook didn't take effect, retain today's PreToolUse approval gate.
3. **Schema split enforced at the route boundary.** Two response shapes (`permissionDecision` for PreToolUse, `decision: {behavior, ...}` for PermissionRequest) live behind two distinct routes and two distinct callbacks; never mixed in one handler. Discriminated-union types in `@sesshin/shared` make field leakage a type error.
4. **Real PermissionRequest output tests for ExitPlanMode and AskUserQuestion.** Their handlers' `HookDecision` outputs go through a documented adapter into the PermissionRequest decision shape; tests assert the wire-level JSON.
5. **Three-tier stale-pending cleanup.** When `PostToolUse` / `PostToolUseFailure` / `Stop` arrives, hub resolves any pending approval matching `(sessionId, toolUseId)`; falls back to `(sessionId, toolName, sha1(tool_input))` when `tool_use_id` is absent and exactly one fingerprint match exists; falls back to singleton-on-Stop when there's exactly one pending request for the session. Resolution outcome: `decision: 'deny'` reasoned `"sesshin: tool already moved past pending request"`.

Plus a Codex-readiness scaffold: a `sanitizeCodexPermissionDecision` adapter (`updatedInput` stripped, `message` only on `deny`) and a 512 KB body-size guard on `/permission`.

## 2. Background

### 2.1 What sesshin does today

- `packages/shared/src/hook-events.ts` defines a normalized event vocabulary `{SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, StopFailure, SessionEnd, agent-internal}`. **No PermissionRequest.**
- `packages/hook-handler/src/main.ts` is a command-hook binary. For `PreToolUse`, it long-polls `POST /hooks` (≤120 s) and forwards the hub's response JSON to claude on stdout; all other events are fire-and-forget.
- `packages/hub/src/rest/server.ts` ingests `/hooks` envelopes and, for `event === 'PreToolUse'`, calls `onPreToolUseApproval`. Output schema is hard-coded to `{hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'allow'|'deny'|'ask', permissionDecisionReason?, updatedInput?}}`.
- `packages/hub/src/approval-manager.ts` keys pending approvals by UUID `requestId`; carries `toolUseId` as an optional field but does not index by it; supports `decide`, `cancelForSession`, `cancelOnLastClientGone`.
- `packages/hub/src/agents/claude/approval-policy.ts` decides whether a PreToolUse should engage the long-poll: gates on policy (`disabled|auto|always`), permission mode (auto modes pass through, default/plan modes gate), allow-rules, and `hasSubscribedClient`. Returns `false` (passthrough → 204) when no decision should be forced.
- `packages/hub/src/agents/claude/tool-handlers/{exit-plan-mode,ask-user-question,bash,file-edit,web-fetch,catch-all}.ts` each implement `ToolHandler.{render,decide}` returning a kind-tagged `HookDecision = {kind:'allow'|'deny'|'ask', additionalContext?, updatedInput?}`. Adapter to PreToolUse-shape decision is in `wire.ts` (the `onPreToolUseApproval` lambda).
- `packages/cli/src/settings-tempfile.ts` generates a per-session temp `settings.json` containing only `hooks.{SessionStart,UserPromptSubmit,PreToolUse,PostToolUse,Stop,StopFailure,SessionEnd}`, each as a `type: "command"` entry that runs the hook-handler binary with env vars `SESSHIN_HUB_URL`, `SESSHIN_SESSION_ID`, `SESSHIN_AGENT` baked in. `packages/cli/src/claude.ts` writes the temp file (mode 0600) to `os.tmpdir()` and spawns `claude --settings <tempPath>`. The user's `~/.claude/settings.json` is never modified.

### 2.2 What changes — and why

Claude Code's authoritative permission gate for tool calls is the `PermissionRequest` hook (HTTP-typed, body shape distinct from PreToolUse, response shape `decision: {behavior, message?, updatedInput?}`). Per `clawd-on-desk`'s known-limitations doc and `anthropics/claude-code#46193`, when a PermissionRequest HTTP hook is registered, Claude routes approval through it and treats HTTP failures as fail-closed deny. PreToolUse decisions on tools that also trigger PermissionRequest are observably best-effort and cannot return the richer PermissionRequest shape (no `updatedPermissions`, no `interrupt`, etc.).

Sesshin's current PreToolUse approval flow is correct for what it does, but it leaves the real gate ungoverned. Goals (1)–(5) close that gap without breaking the existing PreToolUse path or mutating user settings.

### 2.3 Why we keep our temp-settings approach

Clawd-on-desk mutates `~/.claude/settings.json` and registers a fixed URL (`http://127.0.0.1:23333/permission`). Sesshin's per-session temp file is materially better:

- No install/uninstall lifecycle; no idempotency or stale-entry pruning.
- Per-session URL — the sesshin-side sessionId can be baked into the URL path, removing the Claude-native-`session_id` ↔ sesshin-`sessionId` mapping problem clawd has to solve via heuristics.
- Zero risk of corrupting user config or conflicting with co-installed tools (clawd, codex hook installers).
- When sesshin isn't running, `claude` runs against the user's original settings — clawd's "ECONNREFUSED → fail-closed deny" failure mode cannot occur.
- Already covered by `orphan-cleanup.ts`, so HTTP-hook teardown is free.

We extend `generateHooksOnlySettings` to emit one additional `hooks.PermissionRequest` entry as a `type: "http"` hook with `url: "${hubUrl}/permission/${sessionId}"` and `timeout: 600`.

## 3. Architecture overview

```
                        sesshin-cli wraps `claude` per session
                        ───────────────────────────────────────
~/.tmp/sesshin-<sid>.json (mode 0600, generated per invocation)
{
  "hooks": {
    "PreToolUse":  [{ matcher:"*", hooks:[{type:"command", command:"... env ... <bin> PreToolUse"}] }],
    "PostToolUse": [{ matcher:"*", hooks:[{type:"command", command:"... env ... <bin> PostToolUse"}] }],
    "Stop":        [{ matcher:"*", hooks:[{type:"command", command:"... env ... <bin> Stop"}] }],
    ...,
    "PermissionRequest": [{                              // NEW
      "hooks":[{
        "type":"http",
        "url":"http://127.0.0.1:9663/permission/<sid>",
        "timeout":600
      }]
    }]
  }
}

           command hooks                              HTTP hook
              │                                          │
              ▼                                          ▼
┌─────────────────────────────┐         ┌──────────────────────────────┐
│ packages/hook-handler       │         │ Claude POSTs PermissionReq   │
│ binary                      │         │ payload directly to hub      │
│ ── PreToolUse: long-poll    │         │                              │
│    /hooks (≤120s)           │         │                              │
│ ── other events: fire & fwd │         │                              │
└──────────────┬──────────────┘         └────────────────┬─────────────┘
               │ POST /hooks                              │ POST /permission/:sessionId
               │ (sesshin envelope)                       │ (Claude native body)
               ▼                                          ▼
┌──────────────────────────────────────────────────────────────────────┐
│  hub REST                                                            │
│  ┌─────────────────────────────┐    ┌───────────────────────────────┐│
│  │ /hooks                      │    │ /permission/:sessionId  (NEW) ││
│  │ envelope: {agent,sessionId, │    │ body: Claude HTTP-hook        ││
│  │           ts,event,raw}     │    │       payload                 ││
│  │                             │    │                               ││
│  │ if event=='PreToolUse'      │    │ build envelope                ││
│  │ AND !registry.usesPermReq:  │    │   {agent,sessionId,           ││
│  │   onPreToolUseApproval ──► permissionDecision shape              ││
│  │ if event in {PostToolUse,   │    │    ts,event:'PermissionReq.', ││
│  │  PostToolUseFailure,Stop}:  │    │    raw}                       ││
│  │   ApprovalManager.cleanup() │    │ registry.markUsesPermReq(sid) ││
│  │                             │    │ onHookEvent(envelope)  ──► bus││
│  │                             │    │ onPermissionRequestApproval   ││
│  │                             │    │   ──► decision shape          ││
│  └────────────┬────────────────┘    └──────────┬────────────────────┘│
│               │                                │                     │
│               └──────────┬─────────────────────┘                     │
│                          ▼                                           │
│   ┌────────────────────────────────────────────────────────────────┐ │
│   │ ApprovalManager (extended)                                     │ │
│   │   pending Map<requestId, Entry>                                │ │
│   │   byToolUseId Map<sessionId|toolUseId, requestId>      (NEW)   │ │
│   │   byFingerprint Map<sessionId|toolName|fp, Set<reqId>> (NEW)   │ │
│   │   open(...) → request, decision Promise                        │ │
│   │   decide(requestId, outcome)  — existing                       │ │
│   │   resolveByToolUseId(sid,tuid,outcome)            (NEW)        │ │
│   │   resolveByFingerprint(sid,tool,fp,outcome)       (NEW)        │ │
│   │   resolveSingletonForSession(sid,outcome)         (NEW)        │ │
│   │   cancelForSession / cancelOnLastClientGone — existing         │ │
│   └────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

## 4. Schemas

### 4.1 Normalized event vocabulary

`packages/shared/src/hook-events.ts`:

- Add `'PermissionRequest'` to `NormalizedHookEventEnum`.
- Add `'PostToolUseFailure'` to `NormalizedHookEventEnum` (currently falls through to `agent-internal`; promoting it to a first-class event lets the cleanup branch in §6 match it without pattern-sniffing `raw.nativeEvent`).
- Add corresponding entries to `ClaudeHookMap`: `PermissionRequest: 'PermissionRequest'`, `PostToolUseFailure: 'PostToolUseFailure'`.

The hook-handler binary never receives `PermissionRequest` (HTTP hook bypasses it), so `normalize.ts` doesn't change. The enum addition gates downstream consumers (state machine, history, observers).

### 4.2 PermissionRequest input body

Claude's HTTP-hook native payload, parsed with Zod inside the new route:

```ts
const PermissionRequestBody = z.object({
  session_id:        z.string(),     // Claude's native session UUID; preserved in raw
  hook_event_name:   z.literal('PermissionRequest'),
  tool_name:         z.string(),
  tool_input:        z.record(z.unknown()),
  tool_use_id:       z.string().optional(),
  cwd:               z.string().optional(),
  transcript_path:   z.string().optional(),
  permission_mode:   z.string().optional(),
  model:             z.string().optional(),
});
```

Hub builds the envelope:

```ts
{
  agent: 'claude-code',
  sessionId: req.params.sessionId,   // sesshin's id, from URL path
  ts: Date.now(),
  event: 'PermissionRequest',
  raw: parsedBody,                   // includes Claude's native session_id
}
```

### 4.3 Response shapes (new file)

`packages/shared/src/permission.ts`:

```ts
export const PermissionRequestDecision = z.discriminatedUnion('behavior', [
  z.object({
    behavior: z.literal('allow'),
    updatedInput: z.record(z.unknown()).optional(),
  }),
  z.object({
    behavior: z.literal('deny'),
    message: z.string().optional(),
  }),
]);
export type PermissionRequestDecision = z.infer<typeof PermissionRequestDecision>;

export const PermissionRequestResponse = z.object({
  hookSpecificOutput: z.object({
    hookEventName: z.literal('PermissionRequest'),
    decision: PermissionRequestDecision,
  }),
});
export type PermissionRequestResponse = z.infer<typeof PermissionRequestResponse>;
```

The discriminated union forbids `message` on `allow` and `updatedInput` on `deny` at the type level. Cannot accidentally leak fields. PreToolUse's response shape stays inline in `rest/server.ts` — left untouched, untyped in shared/.

### 4.4 Tool-input fingerprint (new file)

`packages/shared/src/tool-fingerprint.ts`:

```ts
const STR_MAX = 240;
const ARR_MAX = 16;
const KEY_MAX = 32;
const DEPTH_MAX = 6;

export function normalizeToolInput(value: unknown, depth = 0): unknown { /* … */ }
export function fingerprintToolInput(input: unknown): string { /* sha1(JSON.stringify(normalized)) */ }
```

Port of clawd's `normalizeToolMatchValue` + `buildToolInputFingerprint`. Bounded normalization keeps the fingerprint stable across logically-equivalent payloads (object key order, oversized strings) without unbounded work. Always returns a hex string.

### 4.5 Codex sanitizer (scaffold, new file)

`packages/hub/src/agents/codex/permission-response.ts`:

```ts
export function sanitizeCodexPermissionDecision(
  d: PermissionRequestDecision,
): PermissionRequestDecision | null {
  if (d.behavior === 'allow') return { behavior: 'allow' };          // no updatedInput, no message
  if (d.behavior === 'deny')  return d.message ? { behavior: 'deny', message: d.message } : { behavior: 'deny' };
  return null;
}
export function buildCodexPermissionResponseBody(d: PermissionRequestDecision): string {
  const sanitized = sanitizeCodexPermissionDecision(d);
  if (!sanitized) return '{}';
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: sanitized } });
}
```

Not wired into any agent path yet. Has its own unit tests against fixtures derived from clawd's `sanitizeCodexPermissionDecision`. Lives behind a future `agent === 'codex'` branch.

## 5. ApprovalManager extensions

`packages/hub/src/approval-manager.ts`:

### 5.1 New fields on `PendingApproval`

```ts
interface PendingApproval {
  requestId: string;
  sessionId: string;
  tool: string;                        // existing — kept as-is, not renamed
  toolInput: unknown;                  // existing
  toolInputFingerprint: string;        // NEW: sha1, always present
  toolUseId?: string;                  // existing
  createdAt: number;
  expiresAt: number;
}
```

Only one new field is added: `toolInputFingerprint`. The earlier draft proposed renaming `tool` → `toolName` for clarity, but that would have churned `wire.ts`, WS broadcast types, and unrelated tests for no functional gain — kept `tool` to keep the diff focused on PermissionRequest semantics. The fingerprint is computed inside `open()` from `input.toolInput` via `fingerprintToolInput`.

### 5.2 New indexes

```ts
private byToolUseId = new Map<string, string>();         // key: `${sid}|${tuid}` → requestId
private byFingerprint = new Map<string, Set<string>>();  // key: `${sid}|${tool}|${fp}` → Set<requestId>
```

Populated at `open()` time; cleared when the entry is removed (decide / resolve / timeout / cancel).

### 5.3 New resolution methods

All return `0 | 1` — the count of requests resolved. All use the same outcome contract as `decide()`.

```ts
resolveByToolUseId(sessionId: string, toolUseId: string, outcome: ApprovalOutcome): 0 | 1;
resolveByFingerprint(sessionId: string, toolName: string, fingerprint: string, outcome: ApprovalOutcome): 0 | 1;
resolveSingletonForSession(sessionId: string, outcome: ApprovalOutcome): 0 | 1;
```

- `resolveByToolUseId` — exact lookup in `byToolUseId`. Unambiguous.
- `resolveByFingerprint` — only resolves if the `Set<requestId>` has exactly one element AND that entry has no `toolUseId` set (clawd's safety: don't fingerprint-match an entry that was already keyed by tool_use_id, since the canonical match should have caught it).
- `resolveSingletonForSession` — only resolves if `pendingForSession(sessionId).length === 1`.

### 5.4 Edge cases

- Two `open()` calls with the same `(sessionId, toolUseId)` (rare; Claude retry?) — second call overwrites the index pointer; first entry's HTTP response is freed only when its own timeout/cancel fires. Documented; not optimized.
- Two `open()` calls with the same `(sessionId, toolName, fingerprint)` — both go into the `Set<requestId>`; subsequent fingerprint cleanup will be skipped (set size > 1) until one is decided/timed-out separately.
- Cleanup outcome for all three methods, when called from the cleanup pathway, is fixed in the route handler:
  ```ts
  { decision: 'deny', reason: 'sesshin: tool already moved past pending request' }
  ```

## 6. Stale cleanup wiring

In `rest/server.ts`'s `ingestHook`, after `onHookEvent` is called, branch on `event`:

```ts
if (parsed.data.event === 'PostToolUse'
 || parsed.data.event === 'PostToolUseFailure'
 || parsed.data.event === 'Stop') {
  const raw = parsed.data.raw;
  const tuid = typeof raw['tool_use_id'] === 'string' ? raw['tool_use_id'] : null;
  const toolName = typeof raw['tool_name'] === 'string' ? raw['tool_name'] : null;
  const fp = (toolName && raw['tool_input'])
    ? fingerprintToolInput(raw['tool_input'])
    : null;
  const outcome = { decision: 'deny' as const, reason: 'sesshin: tool already moved past pending request' };
  const sid = parsed.data.sessionId;

  let resolved =
        (tuid && deps.approvals?.resolveByToolUseId(sid, tuid, outcome)) ||
        (toolName && fp && deps.approvals?.resolveByFingerprint(sid, toolName, fp, outcome)) ||
        (parsed.data.event === 'Stop' && deps.approvals?.resolveSingletonForSession(sid, outcome)) ||
        0;

  // resolved is 0 in the common case (no pending request for this completion);
  // 1 when cleanup fired. No external visibility — purely internal bookkeeping.
}
```

Cleanup fires regardless of which path opened the pending request (PreToolUse or PermissionRequest); both share the same `ApprovalManager`.

`PostToolUseFailure` is added to the enum + map per §4.1 so cleanup can match it directly via the normalized `event` field rather than sniffing `raw.nativeEvent`.

## 7. Per-session opt-in

`packages/hub/src/registry/session-registry.ts` (existing):

- Add `usesPermissionRequest: boolean` (default `false`) to the session record.
- New method `markUsesPermissionRequest(sessionId): boolean` — sets the flag, returns whether it changed.

`/permission/:sessionId` route calls `markUsesPermissionRequest(sid)` *before* dispatch. Sticky: never cleared during the session.

**Diagnostics propagation.** `packages/hub/src/rest/diagnostics.ts` exposes the flag on each session in the `/api/diagnostics` snapshot:

```ts
export function diagnosticsSnapshot(deps: DiagnosticsDeps): {
  sessions: Array<{
    id: string; name: string; state: string;
    permissionMode: string;
    sessionAllowList: string[]; claudeAllowRules: string[];
    pendingApprovals: number;
    hasSubscribedActionsClient: boolean;
    usesPermissionRequest: boolean;     // NEW
  }>;
}
```

Consumer chain:
- CLI `sesshin status` (`packages/cli/src/subcommands/status.ts`) extends its `DiagSession` interface with the new field. Non-JSON output adds `pr=yes|no` to the per-session line; JSON output is automatic. The `/sesshin-status` slash command markdown (`packages/cli/src/commands-bundle/sesshin-status.md`) instructs the LLM to mention the flag in its summary.
- debug-web is **not** a consumer of `/api/diagnostics` (it's WS-driven; verified by grep). No web-side change.

`approval-policy.shouldGatePreToolUse` (existing) gains an extra short-circuit at the top:

```ts
if (knownUsesPermissionRequest === true) return false;
```

`hasSubscribedClient` and `policy === 'always'` already gate; this additional check sits before all of them. The flag is read from the registry by the `wire.ts` adapter that constructs `onPreToolUseApproval`; no change to `shouldGatePreToolUse`'s pure-function signature beyond a new optional parameter.

## 8. CLI install

`packages/cli/src/settings-tempfile.ts`:

```ts
export interface HooksSettingsInput {
  hookHandlerPath: string;
  sessionId: string;
  hubUrl: string;
  agent: 'claude-code';
}

export function generateHooksOnlySettings(o: HooksSettingsInput): string {
  const hooks: Record<string, unknown> = {};
  for (const evt of EVENTS) {                       // existing command-hook loop
    hooks[evt] = [{ matcher: '*', hooks: [{ type: 'command', command: buildCommand(o, evt) }] }];
  }
  hooks['PermissionRequest'] = [{                   // NEW
    hooks: [{
      type: 'http',
      url: `${o.hubUrl}/permission/${o.sessionId}`,
      timeout: 600,
    }],
  }];
  return JSON.stringify({ hooks }, null, 2);
}
```

No matcher key on the HTTP entry (PermissionRequest has no matcher concept). `timeout: 600` matches clawd's value; gives the hub generous headroom over its own approval timeout (default 120 s).

`packages/cli/src/claude.ts` is unchanged; the temp file already gets written via `writeFileSync(tempSettingsPath, ...)` and passed via `--settings tempSettingsPath`.

`mergeUserHooksWithOurs` (existing): no change. User-defined PermissionRequest hooks (if any) get prepended ahead of ours per existing merge semantics. Documented as "user hooks fire first; sesshin's HTTP hook fires last" — Claude executes both, takes the most-restrictive decision (any deny wins).

## 9. Failure modes

| Situation | Response |
|---|---|
| `/permission/:sessionId` body unparseable / fails Zod | 400 `bad json`. Claude treats as no-decision → fall through to TUI (best-effort; constrained by Claude behavior). |
| Body > 512 KB | 200 with `{decision: {behavior: 'deny', message: 'Permission request too large'}}`. |
| `:sessionId` not in registry | 200 with `{decision: {behavior: 'deny', message: 'sesshin: session not registered'}}`. (Different from `/hooks`'s 404; Claude treats unknown HTTP failures as deny anyway, so we make the deny explicit.) |
| `/permission` (no `:sessionId` segment) | 404. |
| `onPermissionRequestApproval` throws | 204 (passthrough); state event still emitted before the throw. Falls back to Claude's TUI rather than fail-closed. |
| Approval timeout | `ApprovalManager` constructor accepts a per-path `timeoutDecision`. PermissionRequest path defaults to `decision: 'deny'` reasoned `'sesshin: approval timed out'` (PreToolUse path keeps `'ask'`). |
| Last actions-capable client disconnects mid-request | Existing `cancelOnLastClientGone(sessionId)` resolves with `decision: 'ask'`. Adapter sees `'ask'` → 204 passthrough. |
| `tool_use_id` absent in PermissionRequest body | Pending entry stored with no `toolUseId`; cleanup falls through to fingerprint match, then singleton-on-Stop. |
| Same `(sessionId, toolUseId)` opened twice | Second open overwrites index pointer; first entry frees only via own timeout/cancel. Documented edge. |
| Cleanup with >1 fingerprint match | Skipped. Both/all entries fall through to their own approval timeout. |

## 10. Files & test plan

### 10.1 Files

**New files (8):**
- `packages/shared/src/permission.ts` — discriminated-union schemas + types
- `packages/shared/src/tool-fingerprint.ts` — normalize + sha1
- `packages/shared/src/tool-fingerprint.test.ts` — fingerprint stability + bounds
- `packages/hub/src/agents/codex/permission-response.ts` — sanitizer scaffold
- `packages/hub/src/agents/codex/permission-response.test.ts` — strip rules
- `packages/hub/src/rest/permission.ts` — `/permission/:sessionId` route handler (extracted from `server.ts` because it's substantial)
- `packages/hub/src/rest/permission.test.ts` — route-level tests
- `tests/e2e/permission-request.test.ts` — end-to-end via spawned hub + simulated Claude HTTP POST

**Edited files (~18):**
- `packages/shared/src/hook-events.ts` — add `PermissionRequest` (and `PostToolUseFailure`) to enum + map
- `packages/shared/src/index.ts` — export new modules
- `packages/hub/src/approval-manager.ts` — new fields, indexes, three resolve methods
- `packages/hub/src/approval-manager.test.ts` — coverage for the three resolve methods + edge cases
- `packages/hub/src/registry/session-registry.ts` — `usesPermissionRequest` field + `markUsesPermissionRequest`
- `packages/hub/src/agents/claude/approval-policy.ts` — short-circuit when registry says session uses PermissionRequest
- `packages/hub/src/agents/claude/approval-policy.test.ts` — new short-circuit case
- `packages/hub/src/rest/server.ts` — register new route; extend PostToolUse/Stop branch with cleanup; reject `event === 'PermissionRequest'` on `/hooks`
- `packages/hub/src/rest/hooks.test.ts` — assert `/hooks` rejects PermissionRequest envelopes; assert cleanup fires on PostToolUse/Stop
- `packages/hub/src/wire.ts` — wire `onPermissionRequestApproval`; share ApprovalManager across both paths
- `packages/hub/src/agents/claude/tool-handlers/exit-plan-mode.test.ts` — assert PermissionRequest-shape JSON for allow/deny paths via the new adapter
- `packages/hub/src/agents/claude/tool-handlers/ask-user-question.test.ts` — assert `updatedInput` propagates correctly into the `behavior: 'allow'` branch
- `packages/cli/src/settings-tempfile.ts` — emit `hooks.PermissionRequest` HTTP entry
- `packages/cli/src/settings-tempfile.test.ts` — assert HTTP-hook JSON shape with URL `/permission/<hex>` and `timeout: 600`
- `packages/hub/src/rest/diagnostics.ts` — add `usesPermissionRequest` to per-session snapshot
- `packages/hub/src/rest/diagnostics.test.ts` — assert default `false`; flips to `true` after `markUsesPermissionRequest`
- `packages/cli/src/subcommands/status.ts` — extend `DiagSession` type; print `pr=yes|no` in non-JSON output
- `packages/cli/src/commands-bundle/sesshin-status.md` — instruct LLM to surface the flag in its summary

### 10.2 Test plan

**Unit — `tool-fingerprint`:** stability across object key reorder; unchanged hash for equivalent payloads; bounded for string > 240 chars / array > 16 / object > 32 keys / depth > 6; null + primitives + nested.

**Unit — `permission-response` (Codex sanitizer):** allow → strips `updatedInput`; deny → keeps `message` only on deny; invalid behavior → returns null / `'{}'`; full response body shape.

**Unit — `ApprovalManager`:**
- `resolveByToolUseId` resolves matched entry, returns 1; returns 0 when no match
- `resolveByFingerprint` resolves single match with no `toolUseId`; returns 0 when set size > 1; returns 0 when match has `toolUseId`
- `resolveSingletonForSession` resolves when count is 1; returns 0 when 0 or 2+
- `open()` populates both indexes correctly; `decide()` clears both
- Cleanup outcome propagates `decision: 'deny'` reason

**Unit — `approval-policy`:** new arg `usesPermissionRequest=true` → returns `false` regardless of mode/policy/allow-list/etc.

**Unit — `settings-tempfile`:** emits `PermissionRequest` HTTP entry alongside command entries; URL `/permission/<sessionId>`; timeout 600.

**Unit — `diagnostics`:** session snapshot has `usesPermissionRequest: false` for a freshly-registered session; flips to `true` after `registry.markUsesPermissionRequest(sid)`. Field is always present on the wire (never undefined).

**Route — `permission.ts`:**
- 200 + valid PermissionRequest decision JSON for allow path (handler returns `kind:'allow'`)
- 200 + deny shape for deny path (handler returns `kind:'deny'`)
- 204 passthrough for `kind:'ask'`
- 200 + sanitized "session not registered" deny when sessionId unknown
- 413-style 200 deny when body > 512 KB
- 400 on Zod failure
- emits `onHookEvent` with envelope `event === 'PermissionRequest'` before dispatch
- `markUsesPermissionRequest` called on the registry

**Route — `hooks.ts`:**
- Cleanup fires for matching `(sessionId, toolUseId)` on PostToolUse
- Cleanup fingerprint fallback fires when `tool_use_id` missing
- Cleanup singleton fallback fires on Stop only
- `/hooks` rejects `event === 'PermissionRequest'` with 400 (schema split enforcement)

**Tool handlers:**
- ExitPlanMode `yes-default` / `yes-accept-edits` → PermissionRequest `behavior: 'allow'`
- ExitPlanMode `no` (with optional freeText) → `behavior: 'deny'` + `message`
- AskUserQuestion `kind:'allow'` carries `updatedInput.answers` through to `decision.updatedInput`
- AskUserQuestion never produces `behavior: 'deny'` (its only outcome is allow with updated input)

**E2E — `permission-request.test.ts`:**
- Spawn hub on a free port; register a fake session
- POST a PermissionRequest payload to `/permission/<sid>`; assert response is `decision`-shaped
- Send a PostToolUse to `/hooks` with the same `tool_use_id`; assert no second pending request remains
- Assert the existing PreToolUse approval flow is suppressed for that session after the PermissionRequest was seen (`shouldGatePreToolUse` short-circuits)
- Assert the PreToolUse path still works for a *different* session (no opt-in)

## 11. Out of scope

- Wiring sanitizer into a real Codex agent path (no Codex hook integration in this branch; scaffolding only).
- Modifying `~/.claude/settings.json` (rejected: temp-file approach is strictly better).
- Adding `permission_mode` propagation from PermissionRequest payload to the registry (tracked elsewhere; the field is preserved in `raw` for future consumers).
- Supporting `updatedPermissions` / `interrupt` in PermissionRequest decisions (Claude does not yet honor; would fail-closed if echoed back).
- Mid-request user re-prompt (e.g., "ask follow-up before deciding") — single-shot decisions only.
- Body-size guard on `/hooks` — out of scope; PermissionRequest is the surface that takes user-controlled tool_input as POST body.

## 12. Open questions (none blocking)

- Should the cleanup outcome reason be different per cleanup path (toolUseId vs fingerprint vs singleton)? Currently uniform; could split for forensics.
- Does Claude Code actually fire PermissionRequest for `ExitPlanMode` and `AskUserQuestion` in current versions? Spec assumes yes (test coverage will catch a regression if not). Empirical validation should be added to `docs/validation-log.md` once the implementation is wired and a real `claude` is exercised against it.
