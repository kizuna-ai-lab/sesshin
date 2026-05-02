# Ambient Remote Control v1.5 — Design

**Status:** Design / pending implementation
**Scope:** Sesshin v1.5 — replaces and generalises the v1 path-B confirmation flow
**Touches:** `packages/shared`, `packages/hub`, `packages/cli`, `packages/debug-web`, `tests/e2e`

## 1. Goal

Make sesshin a transparent overlay on top of every Claude Code permission prompt and interactive tool call:

- The web/IM/device user can **answer any prompt** Claude would have shown in its TUI — permission prompts (Bash, Edit, Write, MultiEdit, NotebookEdit, PowerShell, WebFetch, MCP tools …), `AskUserQuestion`, `ExitPlanMode`, `EnterPlanMode` — using the same options Claude itself would render.
- When **no client is around**, sesshin is invisible: every prompt falls back to the laptop TUI exactly as if sesshin were not running.
- The user's current **permission mode** (default / auto / acceptEdits / bypassPermissions / dontAsk / plan) is tracked authoritatively, including mid-session shift-tab switches, and surfaced to all clients.
- A **sesshin-side allow list** complements Claude's own `permissions.allow`/`deny`. The user can extend it at runtime with `/sesshin-trust`.
- A small set of **`/sesshin-*` slash commands** lets the laptop user query and control sesshin from inside Claude.

This supersedes the v1 path B (PreToolUse confirmation always-on) and removes the auto-mode regression.

## 2. Background

Three findings from the source-code research drive this design:

1. **`auto` mode is invisible to the hook channel.** `PermissionMode.ts:79-90` deliberately maps the internal `auto` mode to `external: 'default'`. The `permission_mode` field in PreToolUse hook payloads cannot distinguish auto from default. The only authoritative source is JSONL `type:"permission-mode"` records (verified empirically: 224 records in one of the user's own sessions, all six values seen).
2. **Claude's actual permission UIs are richer than allow/deny/ask.** Each tool has its own option set (`bashToolUseOptions.tsx`, `permissionOptions.tsx`, `ExitPlanModePermissionRequest.tsx`). Bash has up to five options including editable command-prefix rules; file edits have session-scoped acceptEdits switching; ExitPlanMode has up to seven response values encoding mode-switch + clear-context combinations. Plus accept- and reject-feedback can be appended.
3. **PreToolUse can pre-fill tool input across all tools.** `toolExecution.ts:1130-1131` shows `permissionDecision.updatedInput` rewrites the input for any tool, not just AskUserQuestion. This unifies "answer the question" (AskUserQuestion) and "approve the tool call" (Bash et al.) under one mechanism.
4. **`additionalContext` carries reject-feedback back to the model.** `toolHooks.ts:456` and `toolExecution.ts:845` show that hook results carrying `additionalContext` produce a user-side attachment message in the conversation. We can use this to deliver "No, do X instead" feedback after a remote rejection.

The two limitations of staying with PreToolUse (vs adopting `--permission-prompt-tool`):

- Cannot return rich `updatedPermissions[]` (e.g., `{type: 'setMode', mode: 'acceptEdits'}`). So a remote "Yes, allow all edits this session" answer cannot literally switch the mode in Claude's runtime; sesshin remembers it locally instead.
- Cannot return persistent allow rules. Same — sesshin keeps its own allow list.

We accept these in exchange for the no-client TUI fallback (returning `permissionDecision: 'ask'` defers cleanly to Claude's TUI; the SDK channel has no equivalent).

## 3. Architecture overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                  Sesshin Hub                                │
│                                                                             │
│   ┌──────────────┐    ┌─────────────────┐    ┌──────────────────────────┐   │
│   │  JSONL tail  │───►│ Mode tracker    │    │ Subscribed-client index  │   │
│   │  observer    │    │ (registry       │    │ Set<sessionId, clientId> │   │
│   │              │    │  substate.      │    └──────────┬───────────────┘   │
│   │              │    │  permissionMode)│               │                   │
│   └──────────────┘    └─────────┬───────┘               ▼                   │
│                                 │            ┌──────────────────────────┐   │
│                                 ▼            │ Tool interaction         │   │
│   ┌──────────────────────────────────────────│ handler registry         │   │
│   │ approval-policy.shouldGate({mode,tool,clients,policy,allowList})    │   │
│   └──────────────────────────────────────────│ • Bash, Edit, Write, …   │   │
│                                              │ • AskUserQuestion        │   │
│   ┌──────────────────────────────────────────│ • ExitPlanMode           │   │
│   │ Approval manager (open / decide /        │ • catch-all              │   │
│   │ cancelForSession / cancelOnLastDisconn.) │ render(input) → options  │   │
│   └─────────────┬─────────────┬──────────────│ decide(answer) → JSON    │   │
│                 │             │              └──────────────────────────┘   │
│                 ▼             ▼                                             │
│         ┌──────────────┐ ┌────────────────────────────────────────────┐     │
│         │ REST /hooks  │ │ WS broadcast: session.prompt-request       │     │
│         │ holds resp.  │ │ WS upstream:  prompt-response              │     │
│         └──────────────┘ └────────────────────────────────────────────┘     │
│                 ▲                                                           │
│                 │                                                           │
│         ┌───────┴──────────────────────────────────────────────────┐        │
│         │ /api/diagnostics, /api/trust  (used by sesshin CLI)      │        │
│         └──────────────────────────────────────────────────────────┘        │
└─────────────────────────────────────────────────────────────────────────────┘
       ▲                          ▲                            ▲
       │ PreToolUse hook          │ WS                         │ HTTP (localhost)
       │                          │                            │
       │                          │                            │
┌──────┴──────────┐    ┌──────────┴────────────┐    ┌──────────┴────────────┐
│ hook-handler    │    │ debug-web (or other   │    │ sesshin CLI subcmd:   │
│ (PreToolUse=    │    │ adapter):             │    │ status / clients /    │
│  long-poll)     │    │  InteractionPanel     │    │ history / trust /     │
└─────────────────┘    │  (PromptDialog clone) │    │ gate (/sesshin-* MD)  │
                       └───────────────────────┘    └───────────────────────┘
```

## 4. Components

### 4.1 Mode tracking (the foundation)

**Source of truth.** `type:"permission-mode"` records in Claude's JSONL transcript. Format:
```json
{"type":"permission-mode","permissionMode":"auto","sessionId":"<claude-uuid>"}
```
The `sessionId` here is Claude's own UUID, but the JSONL tail observer is per-sesshin-session and emits with sesshin's session id, so this is harmless.

**Wiring.** Six small changes:

1. **`packages/shared/src/session.ts`** — extend `Substate`:
   ```ts
   export const PermissionModeEnum = z.enum([
     'default','auto','acceptEdits','bypassPermissions','dontAsk','plan'
   ]);
   export const SubstateSchema = z.object({
     // …existing fields…
     permissionMode: PermissionModeEnum.default('default'),
   });
   ```
   Default keeps old serialised snapshots loadable.

2. **`packages/hub/src/agents/claude/normalize-jsonl.ts`** — recognise `permission-mode` records:
   ```ts
   if (parsed.type === 'permission-mode') {
     return {
       eventId, sessionId, ts,
       kind: 'agent-internal',
       payload: { phase: 'mode-change', mode: parsed.permissionMode },
       source: 'observer:session-file-tail',
     };
   }
   ```
   Reuses `agent-internal` (already passes dedup) so no other observer code changes.

3. **`packages/hub/src/registry/session-registry.ts`** — `setPermissionMode(id, mode)` updates substate, emits `substate-changed`, returns false on no-op (avoids redundant broadcasts on the 224-record-per-session firehose).

4. **`packages/hub/src/wire.ts`** — bus subscription:
   ```ts
   bus.on(e => {
     if (e.kind === 'agent-internal' && e.payload['phase'] === 'mode-change') {
       const m = e.payload['mode'];
       if (typeof m === 'string') registry.setPermissionMode(e.sessionId, m as PermissionMode);
     }
   });
   ```

5. **Initial-mode seeding (CLI side).** Before the first JSONL record, seed from settings + flag:
   - Read `~/.claude/settings.json` `permissions.defaultMode` (user-level).
   - Read `<cwd>/.claude/settings.json` `permissions.defaultMode` (project-level, overrides user).
   - Parse `--permission-mode <m>` from `extraArgs` (overrides both).
   - Send the resolved mode in the `/api/sessions` register POST body as `initialPermissionMode`.
   - Hub seeds `substate.permissionMode` at register time.
   - Within ~200 ms the JSONL tail catches up and takes over.

6. **Web header badge.** `SessionDetail.tsx` renders a small badge using Claude's own glyphs from `PermissionMode.ts`:
   | Mode | Badge text | Glyph | Color (Claude's `ModeColorKey`) |
   |---|---|---|---|
   | `default` | `Default` | (none) | `text` (muted) |
   | `auto` | `Auto` | `⏵⏵` | `warning` (yellow) |
   | `acceptEdits` | `Accept` | `⏵⏵` | `autoAccept` (blue/green) |
   | `bypassPermissions` | `Bypass` | `⏵⏵` | `error` (red) |
   | `dontAsk` | `DontAsk` | `⏵⏵` | `error` (red) |
   | `plan` | `Plan` | `⏸` | `planMode` (purple) |

**Future extension (not in v1.5):** PTY scrape of Claude's mode-indicator footer for situations where JSONL hasn't been written yet (e.g., extremely early in a session). Tracked but not implemented.

### 4.2 Wire protocol — `session.prompt-request` (mirrors Claude's `PromptRequest`)

We rename `session.confirmation` to `session.prompt-request` and adopt Claude's own internal shape from `entrypoints/sdk/coreSchemas.ts:976-1012`. Same shape downstream regardless of which tool produced the request; the hub does origin-specific dispatch.

**Downstream (hub → client):**
```ts
{
  type: 'session.prompt-request',
  sessionId: string,
  requestId: string,                  // unique id; client echoes it back
  origin: 'permission'                // PreToolUse for write-class tools
        | 'ask-user-question'         // AskUserQuestion tool_use
        | 'exit-plan-mode'            // ExitPlanMode tool_use
        | 'enter-plan-mode',          // EnterPlanMode tool_use
  toolName: string,                   // claude tool name; useful as a hint on the wire
  toolUseId?: string,
  expiresAt: number,                  // wall-clock millis; UI shows countdown
  body?: string,                      // optional markdown context (plan text, tool_input pretty-print, …)
  questions: Array<{
    prompt: string,                   // question text shown to the user
    header?: string,                  // short chip label (≤12 chars), e.g. claude's `header`
    multiSelect: boolean,
    allowFreeText: boolean,           // true → the panel renders an "Other" / feedback input
    options: Array<{
      key: string,                    // stable identifier the client returns
      label: string,                  // display text
      description?: string,
      preview?: string,               // markdown preview content (claude's option.preview)
      recommended?: boolean,
    }>,
  }>,
}
```

**Upstream (client → hub):**
```ts
{
  type: 'prompt-response',
  sessionId: string,
  requestId: string,
  answers: Array<{
    questionIndex: number,
    selectedKeys: string[],           // empty → free-text only
    freeText?: string,                // when "Other" or feedback was used
  }>,
}
```

**Resolution announcement** (downstream, on decide / timeout / cancel):
```ts
{ type: 'session.prompt-request.resolved',
  sessionId: string, requestId: string,
  reason: 'decided' | 'timeout' | 'cancelled-no-clients' | 'session-ended' }
```

Capability gate: clients must declare `actions` to receive these and to send `prompt-response`.

### 4.3 Tool interaction handler registry

Each tool has a handler with two responsibilities. Registered by tool name in the hub.

```ts
interface ToolHandler {
  /** Build the wire questions/options from the tool's input. */
  render(input: unknown, ctx: HandlerCtx): {
    body?: string;
    questions: PromptQuestion[];
  };
  /** Translate the user's answer into the PreToolUse hook decision. */
  decide(answers: PromptAnswer[], input: unknown, ctx: HandlerCtx): HookDecision;
}

interface HandlerCtx {
  permissionMode: PermissionMode;     // current mode at decide time
  cwd: string;
  sessionAllowList: AllowEntry[];     // sesshin-side allow list for this session
}

type HookDecision =
  | { kind: 'passthrough' }                                      // 204 — let claude do its thing
  | { kind: 'allow'; updatedInput?: object; additionalContext?: string }
  | { kind: 'deny';  reason?: string;     additionalContext?: string }
  | { kind: 'ask';   reason?: string };                          // defer to TUI
```

Initial handler set:

| Tool | Render → questions | Decide → hook output |
|---|---|---|
| `Bash` | One question. Body = command (fenced bash). Options: `yes` (Allow once), `yes-prefix:<editable>` (Yes, don't ask again for `<prefix>` — always-allow exact-match in sesshin's session list), `no` (Deny). `allowFreeText: true` on `yes` and `no` for accept/reject feedback. | `yes` → allow; `yes-prefix` → allow + add to sesshin allow list; `no` → deny + additionalContext=feedback |
| `Edit`, `Write`, `MultiEdit`, `NotebookEdit` | Body = `path: <file>` + diff/content preview. Options: `yes`, `yes-session-scope:<dirname>` ("Yes, allow all edits in `<dirname>/` during this session"), `no`. | `yes-session-scope` adds a wildcard rule `<Tool>(<dirpath>/*)` to sesshin's session list. **Not** a Claude-side mode switch — sesshin remembers locally. |
| `PowerShell` | Same shape as Bash | Same shape as Bash |
| `WebFetch`, `WebSearch` | Body = URL/query. Options: `yes`, `yes-host:<host>` ("allow all fetches to `<host>` this session"), `no`. | Analogous |
| `AskUserQuestion` | Pass through claude's `questions` array verbatim. Each `option` becomes a wire option with key=label-hash. `allowFreeText` derived from "Other" implied by claude. Multi-select honoured. `preview` forwarded. | `allow` + `updatedInput.answers = {<questionText>: <chosenLabel(s)>}` + optional `updatedInput.annotations` |
| `ExitPlanMode` | Body = the plan markdown from `input.plan`. Options: `yes-default` ("Approve and execute"), `yes-accept-edits` ("Approve in acceptEdits mode" — sesshin remembers, web shows badge), `no` (Reject). `allowFreeText: true` on `no` for rejection feedback. | `yes-*` → allow; `yes-accept-edits` also stages a sesshin-side "switch to acceptEdits" hint on the substate (clients see it; Claude's runtime mode unchanged via this path); `no` → deny + additionalContext=feedback |
| `EnterPlanMode` | Body = current task/context. Options: `yes`, `no`. | allow/deny |
| **catch-all** | Body = `tool: <name>` + JSON-stringified input. Options: `allow`, `allow-this-session` (sesshin allow-list), `deny`. `allowFreeText` on both endpoints. | Standard |

**Where the handlers live:** `packages/hub/src/agents/claude/tool-handlers/<ToolName>.ts`, plus a `registry.ts` that exports the dispatch map. `getHandler(toolName)` returns the catch-all if no match.

### 4.4 Approval policy — the gate logic

```ts
shouldGatePreToolUse({
  hookRawMode,           // permission_mode from PreToolUse payload
  knownMode,             // registry.substate.permissionMode (truth)
  hasSubscribedClient,   // ≥1 client subscribed to this session with `actions` cap
  toolName,
  toolInput,
  policy,                // env SESSHIN_APPROVAL_GATE: 'disabled' | 'auto' | 'always'
  sessionAllowList,      // sesshin-side allow rules for this session
  claudeAllowRules,      // user's `permissions.allow` from settings (mirrored at session register)
})
```

Decision precedence (top-down, first hit wins):

```
1. policy === 'disabled'  → false (never gate; sesshin is observational)
2. policy === 'always'    → true  (debug)
3. mode is auto-execute   → false   // {auto, acceptEdits, bypassPermissions, dontAsk, plan}
4. !hasSubscribedClient   → false   // no one to ask → laptop TUI handles
5. tool matches sessionAllowList ∪ claudeAllowRules → false
6. tool ∈ GATED_TOOLS                                → true
7. otherwise                                          → false
```

Notes:
- **`mode` resolution**: prefer `knownMode` (from JSONL); fall back to `hookRawMode`. The collapsed `auto → default` gap is closed once JSONL has been read once.
- **`claudeAllowRules`**: the CLI parses user + project `permissions.allow` at session register and includes it in the register POST body. We mirror Claude's rule format (`Tool(content)`) and matcher exactly via a port of `permissionRuleValueFromString` and `toolMatchesRule`. (See §6 for the parser/matcher port.) **Snapshot-at-register**: edits to the user's `settings.json` mid-session are not honoured until the next sesshin session start. Sesshin's own runtime allow list (`/sesshin-trust`) provides the runtime extension path.
- **`sessionAllowList`**: starts empty. Mutated by (a) handler decisions like `yes-prefix:npm run:*`, (b) `/sesshin-trust` slash command. Cleared on session unregister.
- **`GATED_TOOLS`**: `Bash, Edit, Write, MultiEdit, NotebookEdit, PowerShell, WebFetch, AskUserQuestion, ExitPlanMode, EnterPlanMode, Skill`, plus any `mcp__*` tool. Read-only tools (`Read, Glob, Grep, LS, Task, TaskOutput, WebSearch`) are NOT gated by default — they're already auto-allowed by Claude.

### 4.5 Subscribed-client gating

The hub maintains a per-session `Set<connectionId>` of clients that:
- have completed `client.identify`,
- declared the `actions` capability,
- subscribed to this session (or `'all'`).

`hasSubscribedClient(sessionId)` is true if the set is non-empty.

**Last-client-disconnect handling (R3).** When the set transitions to empty, the hub iterates pending approvals for that session and resolves each as `{decision: 'ask', reason: 'sesshin: last client disconnected'}`. The hook-handler unblocks; Claude's TUI takes over. Without this, a client that closes mid-card would leave Claude blocked until the per-approval timeout (60 s default).

### 4.6 Approval manager (already exists)

Extend `ApprovalManager` from path B with:
- `cancelOnLastClientGone(sessionId)` — used by the disconnect handler above. Same semantics as `cancelForSession` but with a different telemetry reason.
- `pendingForSession(sessionId)` — already exists; used by `/sesshin-status`.

### 4.7 Sesshin-side allow list

Per-session, in-memory:
```ts
type AllowEntry = {
  toolName: string;
  // Same shape as Claude's PermissionRuleValue — null content means "all calls of this tool"
  ruleContent: string | null;
  source: 'handler' | 'trust-command';
  addedAt: number;
};
```
Stored in the session record. Cleared on `session-removed`. Not persisted to disk in v1.5 (a future iteration can persist per-project).

Matcher: port of Claude's `toolMatchesRule` for the tools we care about (Bash prefix matching, file-path glob, host matching). For tools we don't have specific matchers for, exact-string match on `JSON.stringify(input)`.

### 4.8 Hook handler — the long-poll arm

(Already implemented in path B; only minor changes.)

- For `PreToolUse`: long-poll POST to `/hooks` with up to 120 s, parse response body as `hookSpecificOutput` JSON, emit on stdout.
- For all other events: existing 250 ms fire-and-forget.
- Fallback to `{permissionDecision: 'ask'}` on hub timeout / unreachable / malformed body.

No new code; existing tests cover this.

### 4.9 CLI subcommands and REST endpoints

New REST routes on the hub (localhost only):

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/diagnostics` | snapshot: sessions, modes, gate policy, pending approvals, allow lists, connected clients |
| GET | `/api/sessions/:id/clients` | per-session client list with capabilities |
| GET | `/api/sessions/:id/history` | last N resolved prompt-requests |
| POST | `/api/sessions/:id/trust` | body `{ ruleString: 'Bash(git log:*)' }` — adds to sesshin allow list |
| POST | `/api/sessions/:id/gate` | body `{ policy: 'disabled'\|'auto'\|'always' }` — per-session override |
| POST | `/api/sessions/:id/pin` | body `{ message }` — sticky note broadcast to clients |
| POST | `/api/sessions/:id/quiet` | body `{ ttlMs }` — suppress notifications for ttl |

CLI subcommands (`packages/cli/src/main.ts`):
```
sesshin status [--session <id>] [--json]
sesshin clients [--session <id>]
sesshin history [--session <id>] [-n <count>]
sesshin trust   <ruleString>             # e.g. sesshin trust 'Bash(git log:*)'
sesshin gate    <off|auto|always>        # current session if running inside one
sesshin pin     <message>
sesshin quiet   <duration>               # 5m / 30s / 1h
```
Each is a thin wrapper that hits the corresponding REST endpoint and prints JSON or a one-liner. They auto-detect "current session" from `SESSHIN_SESSION_ID` env (set by the wrapper for slash-command Bash invocations), or take an explicit `--session`.

### 4.10 Slash commands

Bundled markdown files under `packages/cli/commands-bundle/` (project-relative):

- `sesshin-status.md`
- `sesshin-clients.md`
- `sesshin-history.md`
- `sesshin-trust.md`
- `sesshin-gate.md`
- `sesshin-pin.md`
- `sesshin-quiet.md`

Each ~5 lines:
```markdown
---
description: Show current sesshin session status
allowed-tools: Bash(sesshin status:*)
---
Run `sesshin status --json --session $SESSHIN_SESSION_ID` and summarise the current
mode, gate policy, connected clients, and recent confirmations.
```

**Distribution.** Empirical question to be answered before commit 6: does `claude --settings <file>` honour `enabledPlugins` containing `commandsPath`? If yes, we ship via per-session plugin entry in the temp settings file (cleanest — no global pollution). If no, fall back: `sesshin commands install` writes the bundled `.md` files to `~/.claude/commands/`. We commit the loader code paired with the empirical probe; whichever path works, only one commit affects the runtime.

## 5. Wire-format details

### 5.1 Bash handler — render

Input `{ command, description? }`:
```
body =
  ```bash
  <command>
  ```
  <description?>

questions[0] = {
  prompt: 'Run this command?',
  header: 'Bash',
  multiSelect: false,
  allowFreeText: false,        // feedback inputs become per-option (see below)
  options: [
    { key: 'yes',           label: 'Yes' },
    { key: 'yes-prefix',    label: 'Yes, don’t ask again for',
      description: 'Editable prefix; sesshin remembers for this session.',
      // The web panel renders an inline editable prefix input when this option is focused.
      // Default suggested prefix: heuristic from commandToPrefix(command) (e.g. 'git log:*').
      // The chosen prefix arrives back in the answer's freeText field.
    },
    { key: 'no',            label: 'No' },
  ],
}
```

Web UX nuance: when `key === 'yes-prefix'` is focused, the panel surfaces an editable text field that pre-fills with a heuristic prefix; the submitted text travels in `answers[0].freeText`. When `yes` or `no` is focused, an optional feedback input is exposed (matching Claude's `yesInputMode`/`noInputMode`).

### 5.2 Bash handler — decide

```ts
switch (selectedKey) {
  case 'yes':
    return { kind: 'allow' }
  case 'yes-prefix': {
    const prefix = answer.freeText ?? heuristicPrefix(input.command);
    sessionAllowList.add({ toolName: 'Bash', ruleContent: prefix });
    return { kind: 'allow' }
  }
  case 'no': {
    const feedback = answer.freeText;
    return feedback
      ? { kind: 'deny', additionalContext: feedback }
      : { kind: 'deny' }
  }
}
```

### 5.3 AskUserQuestion handler — render

```ts
render(input, ctx) {
  return {
    questions: input.questions.map(q => ({
      prompt: q.question,
      header: q.header,
      multiSelect: q.multiSelect,
      allowFreeText: true,   // claude always implicitly adds "Other"
      options: q.options.map(o => ({
        key: hash(o.label),
        label: o.label.replace(/\s+\(Recommended\)$/, ''),
        description: o.description,
        preview: o.preview,
        recommended: /\s+\(Recommended\)$/.test(o.label),
      })),
    })),
  };
}
```

### 5.4 AskUserQuestion handler — decide

Build `updatedInput.answers` exactly as Claude's `mapToolResultToToolResultBlockParam` (`AskUserQuestionTool.tsx:225-247`) expects on the inverse side:

```ts
const answers: Record<string, string> = {};
const annotations: Record<string, {preview?: string; notes?: string}> = {};
for (const [qIdx, ans] of zip(input.questions, request.answers)) {
  const q = input.questions[qIdx];
  if (q.multiSelect) {
    const labels = ans.selectedKeys.map(keyToLabel).concat(ans.freeText ? [ans.freeText] : []);
    answers[q.question] = labels.join(', ');
  } else {
    answers[q.question] = ans.freeText ?? keyToLabel(ans.selectedKeys[0]);
  }
  // Forward preview if the chosen option had one
  const chosen = q.options.find(o => o.label === keyToLabel(ans.selectedKeys[0]));
  if (chosen?.preview) (annotations[q.question] ||= {}).preview = chosen.preview;
  if (ans.notes)        (annotations[q.question] ||= {}).notes   = ans.notes;
}
return { kind: 'allow', updatedInput: { ...input, answers, annotations } };
```

This produces the same `tool_result` content Claude would have produced from its TUI:
```
User has answered your questions: "<q>"="<label>" ...
```
because Claude's tool runs identically with our pre-filled `answers`, then `mapToolResultToToolResultBlockParam` formats them.

### 5.5 ExitPlanMode handler

Render the plan markdown as `body`. Three options: `yes-default`, `yes-accept-edits`, `no`. `no` carries `additionalContext` from `answer.freeText`. The accept variants both return `{kind: 'allow'}`; the `yes-accept-edits` variant additionally sets a sesshin-side "preferAcceptEdits" hint on the substate (visible to clients), but does NOT switch Claude's runtime mode (PreToolUse can't). User shift-tabs on laptop if they want the actual mode change.

### 5.6 Permission rule parser/matcher port

Port from `utils/permissions/permissionRuleParser.ts` (parse/format) and `utils/permissions/permissions.ts:238` (`toolMatchesRule`). New file `packages/hub/src/agents/claude/permission-rules.ts`:
```ts
export function parseRuleString(s: string): { toolName: string; ruleContent: string | null };
export function formatRuleString(toolName: string, content: string | null): string;
export function toolMatchesRule(toolName: string, input: unknown, rule: AllowEntry): boolean;
```
Per-tool match logic:
- **Bash / PowerShell**: rule `Bash(npm run:*)` matches `command.startsWith('npm run')`. Rule `Bash(npm install)` matches `command === 'npm install'`. The `:*` suffix is Claude's prefix-wildcard convention.
- **Edit / Write / MultiEdit / NotebookEdit**: rule `Edit(/path/to/dir/*)` matches when `file_path` is inside that dir (recursive). Rule `Edit(/exact/file.md)` matches exact path.
- **WebFetch / WebSearch**: rule `WebFetch(https://example.com/*)` matches host or prefix.
- **Bare tool name** (`Bash`): matches all calls of that tool.
- **Unknown tools**: exact-string match on `JSON.stringify(input)` against `ruleContent`.

We intentionally do NOT replicate Claude's classifier-based rules (those are LLM-driven and ant-only).

## 6. Failure modes and fallbacks

| Scenario | Behavior |
|---|---|
| Hub unreachable from hook handler | Hook returns `permissionDecision: 'ask'` → laptop TUI prompts |
| No subscribed client | Gate decision: passthrough → 204 → hook returns no JSON → laptop TUI prompts |
| Client disconnects while approval is pending | `cancelOnLastClientGone` resolves all pending as `'ask'` → TUI prompts |
| Approval times out (60 s default) | Resolves as `'ask'` → TUI prompts |
| Tool handler throws | Default `{kind: 'ask'}` with reason; TUI prompts |
| JSONL `permission-mode` record malformed | Ignored; existing substate.permissionMode unchanged |
| Settings file malformed | Initial mode falls back to `'default'`; logged at `warn` |
| Hook payload schema mismatch | Existing zod safeParse → 400; hook handler emits "ask" |

In **every** failure mode, behavior degrades to "as if sesshin were not running" rather than "sesshin blocks Claude."

## 7. Testing strategy

### Unit
- `normalize-jsonl`: `permission-mode` records produce expected agent-internal events.
- `session-registry.setPermissionMode`: idempotent, emits substate-changed.
- `approval-policy`: full matrix incl. auto-mode no-gate and last-client-disconnect cases.
- `permission-rules`: parser round-trip; matcher per tool family (Bash prefix, Edit dir glob, WebFetch host).
- Each tool handler: render produces the expected wire shape; decide produces correct hook decision for each option.

### Integration
- Hub: simulate JSONL line + PreToolUse hook + WS client subscribe + prompt-response; verify decision flows.
- Hub: simulate client disconnect during pending approval; verify cancel+resolve.

### E2E
- Extend stub-claude to emit `permission-mode:auto` records; assert no `session.prompt-request` is broadcast for Bash even though policy=auto and tool ∈ GATED_TOOLS.
- New e2e: switch mode mid-session via stub-emitted record; assert behavior changes accordingly.
- Existing e2e (PreToolUse → WS prompt-request → WS prompt-response → claude proceeds) — stays green with renamed message types.

## 8. Implementation phases / commit topology

Each commit ships green tests + e2e and is independently shippable.

| # | Title | Approx LOC |
|---|---|---|
| 1 | `feat(shared,hub): track permissionMode on Substate from JSONL` | ~150 |
| 2 | `feat(cli): seed permissionMode at session register from settings + flags` | ~120 |
| 3 | `fix(hub): approval-policy honours authoritative mode (auto-mode regression)` | ~80 |
| 4 | `feat(hub,web): rename session.confirmation → session.prompt-request (PromptRequest shape)` | ~250 |
| 5 | `feat(hub): tool interaction handler registry + Bash/file/AskUserQuestion/ExitPlanMode handlers` | ~500 |
| 6 | `feat(hub): claude-style permission-rules parser + matcher; mirror user's permissions.allow` | ~250 |
| 7 | `feat(hub): subscribed-client gating + last-client-disconnect cancel` | ~120 |
| 8 | `feat(hub,web): web header mode badge + InteractionPanel render of new shape` | ~200 |
| 9 | `feat(cli,hub): /api/diagnostics endpoints + sesshin status/clients/history subcommands` | ~250 |
| 10 | `feat(cli): bundled slash commands + plugin entry in settings tempfile (with empirical probe)` | ~200 |
| 11 | `feat(cli,hub): /sesshin-trust + /sesshin-gate + /sesshin-pin + /sesshin-quiet (mutating commands)` | ~200 |
| 12 | `docs: README / CLAUDE.md / architecture.md updates for v1.5` | ~150 |

Total ≈ 2,400 LOC across 12 commits. Ships incrementally to `main`.

## 9. Out of scope / deferred

- **`--permission-prompt-tool` MCP channel.** Would unlock real `updatedPermissions[]` (mode switch, persistent rules). Costs no-client TUI fallback. Future opt-in env `SESSHIN_USE_PERMISSION_PROMPT_TOOL=1`.
- **Persistent (cross-session) sesshin allow list.** v1.5 is session-scoped only.
- **PTY-scrape mode detector** for the JSONL warm-up window (first ~200 ms of a session).
- **Codex / Gemini support.** All tool handlers and JSONL parsing are claude-specific. The wire protocol and registry are agent-agnostic; adding another agent is "implement normalize-X.ts + tool handlers."
- **AskUserQuestion preview rendering.** Schema carries `preview` markdown across the wire; the web component renders it as plain markdown. Side-by-side preview layout is not in v1.5.
- **Notification escalation (push to phone).** Original product brief item; still deferred.
- **Sesshin-side `/sesshin-history` persistence across hub restarts.** In-memory only.

## 10. Migration / rollout

- All changes are additive to the WS protocol except the rename `session.confirmation` → `session.prompt-request`. Web client updates atomically since it's in the same repo. No external clients exist yet.
- `Substate.permissionMode` is additive with default `'default'`; old checkpoint snapshots load fine.
- The CLI register POST body gains `initialPermissionMode`; hub treats it as optional. Cross-version safe.
- Existing v1 PreToolUse path B gets superseded by the new handler registry — but the wire mechanism (long-poll hook, hub holds, web answers) is unchanged. Net: no behavioural regression for users; richer UI/options.

## Appendix A — empirical evidence

- `auto`/`default` collapse: confirmed by running `claude -p --permission-mode auto` and reading `permission_mode` field in PreToolUse stdin payload (5 modes correctly reported, `auto` reports as `default`).
- `permission-mode` JSONL records: 224 occurrences in `~/.claude/projects/.../346572fd-3272-4415-a94b-ab317e6528e9.jsonl` covering all six values.
- AskUserQuestion shape: captured live `tool_use` and `tool_result` records from the user's own sessions; confirmed format matches `mapToolResultToToolResultBlockParam` in `AskUserQuestionTool.tsx:225-247`.
- `additionalContext` propagation: traced through `services/tools/toolHooks.ts:456` and `services/tools/toolExecution.ts:845`.
- Bash option set: read from `components/permissions/BashPermissionRequest/bashToolUseOptions.tsx`.
- File option set: read from `components/permissions/FilePermissionDialog/permissionOptions.tsx`.
- ExitPlanMode response values: read from `components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.tsx`.
- Mode glyphs and short titles: `utils/permissions/PermissionMode.ts:43-91`.
- Permission rule format: `utils/permissions/permissionRuleParser.ts`.

## Appendix B — file inventory

New files:
- `packages/hub/src/agents/claude/permission-rules.ts` (+ test)
- `packages/hub/src/agents/claude/tool-handlers/index.ts` (registry)
- `packages/hub/src/agents/claude/tool-handlers/<ToolName>.ts` × ~10 (+ tests)
- `packages/hub/src/observers/jsonl-mode-tracker.ts` — small module; subscribes to `bus`, dispatches mode-change events to `registry.setPermissionMode`. (Could be inlined in `wire.ts` but separated for testability.)
- `packages/cli/src/read-claude-settings.ts` (+ test)
- `packages/cli/src/commands-bundle/sesshin-*.md` × 7
- `packages/cli/src/subcommands/{status,clients,history,trust,gate,pin,quiet}.ts`
- `packages/debug-web/src/components/InteractionPanel.tsx` (replaces ConfirmationPanel)
- `packages/debug-web/src/components/ModeBadge.tsx`

Modified files:
- `packages/shared/src/protocol.ts` (rename + new schemas)
- `packages/shared/src/session.ts` (Substate adds permissionMode)
- `packages/hub/src/registry/session-registry.ts` (+setPermissionMode)
- `packages/hub/src/wire.ts` (mode bus subscription, client tracker, last-disconnect handler)
- `packages/hub/src/rest/server.ts` (new diagnostic endpoints)
- `packages/hub/src/ws/{server,connection}.ts` (capabilities for new messages)
- `packages/hub/src/approval-manager.ts` (cancelOnLastClientGone)
- `packages/hub/src/agents/claude/approval-policy.ts` (multi-input signature)
- `packages/cli/src/{main,claude}.ts` (subcommand dispatch + initial mode seed + plugin entry)
- `packages/cli/src/settings-tempfile.ts` (optional `enabledPlugins` injection)
- `packages/debug-web/src/{store,ws-client}.ts` (rename + InteractionPanel state)
- `packages/debug-web/src/components/SessionDetail.tsx` (mode badge)
- `tests/e2e/{run-e2e.mjs,stub-claude/index.mjs}` (new mode-change scenarios)
