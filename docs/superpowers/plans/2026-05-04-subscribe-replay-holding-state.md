# Subscribe-time replay of holding state — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the hub re-broadcast its current per-session holding state (pending prompt-requests, sticky pin/quiet/gate config) to any client that subscribes mid-session — fixing GitHub issue #5 where refresh / late-joining clients see an empty UI even though the hub is still holding hooks open.

**Architecture:** Three additive changes to the WS protocol, all backwards compatible: (1) `SessionInfo` carries the three sticky-config fields; (2) on `subscribe`, the hub iterates `pendingForSession()` and re-emits each entry as a `session.prompt-request` frame; (3) a new `session.config-changed` wire message broadcasts runtime mutations of those three fields. Plus a `resolvedBy` field on `prompt-request.resolved` so clients can distinguish "answered by another client" from "timed out / cancelled by hub". Hook-handler protocol is **not** modified.

**Tech Stack:** TypeScript pnpm workspace, Zod schemas in `packages/shared`, EventEmitter-based hub, `ws` library for WebSocket, Vitest for tests, Preact signals in `debug-web`.

**Spec:** `docs/superpowers/specs/2026-05-04-subscribe-replay-holding-state-design.md`

---

## File Structure

| File | Change |
|---|---|
| `packages/shared/src/session.ts` | modify — `SessionInfoSchema` += three sticky-config fields |
| `packages/shared/src/session.test.ts` | modify — schema parse tests |
| `packages/shared/src/protocol.ts` | modify — `SessionPromptRequestResolvedSchema` += `resolvedBy` and `'cancelled-tool-completed'`; new `SessionConfigChangedSchema` in discriminated union |
| `packages/shared/src/protocol.test.ts` | modify — schema parse tests |
| `packages/hub/src/approval-manager.ts` | modify — `Entry` / `PendingApproval` += `origin`, `body?`, `questions`; `open()` requires them; `pendingForSession()` returns them |
| `packages/hub/src/approval-manager.test.ts` | modify — open / pendingForSession tests for new fields |
| `packages/hub/src/registry/session-registry.ts` | modify — `publicView` no longer strips three fields; setters emit `'config-changed'` with no-op short-circuit; new event in `RegistryEvents` |
| `packages/hub/src/registry/session-registry.test.ts` | modify — publicView shape; setters emit; no-op |
| `packages/hub/src/ws/server.ts` | modify — `capabilityRequiredFor('session.config-changed') → 'state'`; `onPromptResponse` signature += `clientKind: string` |
| `packages/hub/src/ws/server.test.ts` | modify — capability gating |
| `packages/hub/src/ws/connection.ts` | modify — subscribe replay of pending; `onConfigChanged` listener; pass `state.kind` to `onPromptResponse` |
| `packages/hub/src/ws/connection.test.ts` | modify — subscribe-replay test suite (~13 cases) |
| `packages/hub/src/wire.ts` | modify — pass `origin/body/questions` from `handler.render()` to `approvals.open()` (PreToolUse + PermissionRequest); add `resolvedBy` to all 6 `prompt-request.resolved` broadcast points |
| `packages/hub/src/wire.test.ts` | create — `resolvedBy` attribution per broadcast path |
| `packages/debug-web/src/ws-client.ts` | modify — handle `session.config-changed` |
| `packages/debug-web/src/store.ts` | modify — `applyConfigChanged()` mutator; `removeSession()` also clears `promptRequestsBySession[id]` |
| `packages/debug-web/src/store.test.ts` | create — `removeSession` clears prompt-cards |

---

## Task ordering rationale

Bottom-up to keep the build green between commits:

1. **Tasks 1–3:** `@sesshin/shared` schema additions (zero deps).
2. **Task 4:** `ApprovalManager` API extension (depends on `PromptQuestion` type from shared).
3. **Task 5:** `wire.ts` callers updated to satisfy new `open()` signature (must follow Task 4 in same commit chain or build breaks).
4. **Tasks 6–7:** `SessionRegistry` and `wire.ts` `resolvedBy` plumbing.
5. **Tasks 8–9:** `ws/server.ts` + `ws/connection.ts` subscribe-replay + config-changed listener + clientKind plumbing.
6. **Tasks 10–12:** `debug-web` consumer side.
7. **Task 13:** Manual verification.

---

## Test commands cheat-sheet

| Goal | Command |
|---|---|
| Run one test file in shared | `pnpm --filter @sesshin/shared test src/session.test.ts` |
| Run one test file in hub | `pnpm --filter @sesshin/hub test src/approval-manager.test.ts` |
| Run all hub tests | `pnpm --filter @sesshin/hub test` |
| Build all (typecheck) | `pnpm build` |

---

### Task 1: Extend `SessionInfoSchema` with sticky-config fields

**Files:**
- Modify: `packages/shared/src/session.ts`
- Modify: `packages/shared/src/session.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `packages/shared/src/session.test.ts`:

```ts
describe('SessionInfoSchema sticky config fields', () => {
  const base = {
    id: 's', name: 'n', agent: 'claude-code' as const,
    cwd: '/x', pid: 1, startedAt: 0,
    state: 'idle' as const,
    substate: {
      currentTool: null, lastTool: null, lastFileTouched: null,
      lastCommandRun: null, elapsedSinceProgressMs: 0, tokensUsedTurn: null,
      connectivity: 'ok' as const, stalled: false,
      permissionMode: 'default' as const, compacting: false, cwd: null,
    },
    lastSummaryId: null,
  };

  it('accepts pin / quietUntil / sessionGateOverride as null', () => {
    const r = SessionInfoSchema.parse({
      ...base, pin: null, quietUntil: null, sessionGateOverride: null,
    });
    expect(r.pin).toBeNull();
    expect(r.quietUntil).toBeNull();
    expect(r.sessionGateOverride).toBeNull();
  });

  it('accepts pin / quietUntil / sessionGateOverride as concrete values', () => {
    const r = SessionInfoSchema.parse({
      ...base, pin: 'deploying', quietUntil: 1700000000000,
      sessionGateOverride: 'always',
    });
    expect(r.pin).toBe('deploying');
    expect(r.quietUntil).toBe(1700000000000);
    expect(r.sessionGateOverride).toBe('always');
  });

  it('accepts the three fields as missing (backwards compat)', () => {
    const r = SessionInfoSchema.parse(base);
    expect(r.pin).toBeUndefined();
    expect(r.quietUntil).toBeUndefined();
    expect(r.sessionGateOverride).toBeUndefined();
  });

  it('rejects invalid sessionGateOverride enum value', () => {
    expect(() => SessionInfoSchema.parse({
      ...base, sessionGateOverride: 'sometimes',
    })).toThrow();
  });
});
```

Make sure `SessionInfoSchema` is imported at the top of the file (it already is — check the existing imports).

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @sesshin/shared test src/session.test.ts
```

Expected: 4 failures — `pin`, `quietUntil`, `sessionGateOverride` parses succeed but return `undefined` (the schema doesn't know about them yet), and the rejection test fails because zod silently accepts unknown fields.

- [ ] **Step 3: Add the three fields to `SessionInfoSchema`**

In `packages/shared/src/session.ts`, locate `SessionInfoSchema` (≈ line 44) and append three fields after `sessionFilePath`:

```ts
export const SessionInfoSchema = z.object({
  id:              z.string(),
  name:            z.string(),
  agent:           AgentEnum,
  cwd:             z.string(),
  pid:             z.number().int(),
  startedAt:       z.number().int(),
  state:           SessionStateEnum,
  substate:        SubstateSchema,
  lastSummaryId:   z.string().nullable(),
  sessionFilePath: z.string().optional(),
  // Sticky user-set session config. All three are nullable+optional:
  // - missing: schema-level backwards compatibility for old payloads
  // - null:    explicitly unset (default after register())
  // - value:   user has set this via `sesshin pin/quiet/gate` etc.
  pin:                 z.string().nullable().optional(),
  quietUntil:          z.number().int().nullable().optional(),
  sessionGateOverride: z.enum(['disabled','auto','always']).nullable().optional(),
});
```

- [ ] **Step 4: Run tests to verify pass**

```bash
pnpm --filter @sesshin/shared test src/session.test.ts
```

Expected: all tests pass, including the existing 3 cases.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/session.ts packages/shared/src/session.test.ts
git commit -m "feat(shared): SessionInfo carries pin/quietUntil/sessionGateOverride

Adds the three sticky-config fields to SessionInfoSchema as nullable
optional so session.list and session.added carry them to subscribed
clients. Part of issue #5 (subscribe-time replay of holding state)."
```

---

### Task 2: Extend `SessionPromptRequestResolvedSchema` with `resolvedBy` and `'cancelled-tool-completed'`

**Files:**
- Modify: `packages/shared/src/protocol.ts`
- Modify: `packages/shared/src/protocol.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `packages/shared/src/protocol.test.ts`:

```ts
import { SessionPromptRequestResolvedSchema } from './protocol.js';

describe('SessionPromptRequestResolvedSchema additions', () => {
  const base = {
    type: 'session.prompt-request.resolved' as const,
    sessionId: 's', requestId: 'r',
  };

  it('accepts resolvedBy as remote-adapter:<kind>', () => {
    const r = SessionPromptRequestResolvedSchema.parse({
      ...base, reason: 'decided', resolvedBy: 'remote-adapter:debug-web',
    });
    expect(r.resolvedBy).toBe('remote-adapter:debug-web');
  });

  it('accepts resolvedBy as hub-stale-cleanup', () => {
    const r = SessionPromptRequestResolvedSchema.parse({
      ...base, reason: 'cancelled-tool-completed', resolvedBy: 'hub-stale-cleanup',
    });
    expect(r.resolvedBy).toBe('hub-stale-cleanup');
  });

  it('accepts resolvedBy as null', () => {
    const r = SessionPromptRequestResolvedSchema.parse({
      ...base, reason: 'timeout', resolvedBy: null,
    });
    expect(r.resolvedBy).toBeNull();
  });

  it('accepts resolvedBy missing (backwards compat)', () => {
    const r = SessionPromptRequestResolvedSchema.parse({
      ...base, reason: 'session-ended',
    });
    expect(r.resolvedBy).toBeUndefined();
  });

  it('accepts cancelled-tool-completed as a reason value', () => {
    const r = SessionPromptRequestResolvedSchema.parse({
      ...base, reason: 'cancelled-tool-completed',
    });
    expect(r.reason).toBe('cancelled-tool-completed');
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
pnpm --filter @sesshin/shared test src/protocol.test.ts
```

Expected: 5 failures — `resolvedBy` is not in the schema yet, and `'cancelled-tool-completed'` is rejected by the enum.

- [ ] **Step 3: Add the two fields**

In `packages/shared/src/protocol.ts`, locate `SessionPromptRequestResolvedSchema` (≈ line 162):

```ts
export const SessionPromptRequestResolvedSchema = z.object({
  type:       z.literal('session.prompt-request.resolved'),
  sessionId:  z.string(),
  requestId:  z.string(),
  reason:     z.enum([
    'decided',
    'timeout',
    'cancelled-no-clients',
    'cancelled-tool-completed',  // NEW: was already emitted by wire.ts:202
                                 // but missing from this enum (pre-existing
                                 // schema/code drift fixed here)
    'session-ended',
  ]),
  // NEW: identifies who caused the resolution. Lets clients render UX
  // distinguishing "approved by another client" from system-initiated
  // events (timeout, session-end). 'remote-adapter:<kind>' for client
  // decisions; 'hub-stale-cleanup' for hub-driven cleanup; null/missing
  // for system actions with no actor.
  resolvedBy: z.string().nullable().optional(),
});
```

- [ ] **Step 4: Run tests to verify pass**

```bash
pnpm --filter @sesshin/shared test src/protocol.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/protocol.ts packages/shared/src/protocol.test.ts
git commit -m "feat(shared): prompt-request.resolved carries resolvedBy + new reason

- resolvedBy attributes the resolution actor ('remote-adapter:<kind>',
  'hub-stale-cleanup', or null for system actions).
- Adds 'cancelled-tool-completed' to the reason enum (wire.ts:202
  already emitted this string; the schema was silently out of sync).

Part of issue #5."
```

---

### Task 3: Add `SessionConfigChangedSchema` to the wire protocol

**Files:**
- Modify: `packages/shared/src/protocol.ts`
- Modify: `packages/shared/src/protocol.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `packages/shared/src/protocol.test.ts`:

```ts
import { SessionConfigChangedSchema, DownstreamMessageSchema } from './protocol.js';

describe('SessionConfigChangedSchema', () => {
  it('parses a snapshot with all-null fields', () => {
    const r = SessionConfigChangedSchema.parse({
      type: 'session.config-changed', sessionId: 's',
      pin: null, quietUntil: null, sessionGateOverride: null,
    });
    expect(r.sessionId).toBe('s');
    expect(r.pin).toBeNull();
  });

  it('parses a snapshot with all-set fields', () => {
    const r = SessionConfigChangedSchema.parse({
      type: 'session.config-changed', sessionId: 's',
      pin: 'deploy', quietUntil: 123, sessionGateOverride: 'auto',
    });
    expect(r.pin).toBe('deploy');
    expect(r.quietUntil).toBe(123);
    expect(r.sessionGateOverride).toBe('auto');
  });

  it('routes through DownstreamMessageSchema discriminated union', () => {
    const r = DownstreamMessageSchema.parse({
      type: 'session.config-changed', sessionId: 's',
      pin: null, quietUntil: null, sessionGateOverride: null,
    });
    expect(r.type).toBe('session.config-changed');
  });

  it('rejects partial snapshots (all three fields are required)', () => {
    expect(() => SessionConfigChangedSchema.parse({
      type: 'session.config-changed', sessionId: 's',
      pin: 'x',  // missing quietUntil and sessionGateOverride
    })).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
pnpm --filter @sesshin/shared test src/protocol.test.ts
```

Expected: 4 failures — `SessionConfigChangedSchema` doesn't exist yet.

- [ ] **Step 3: Add the schema and wire it into the union**

In `packages/shared/src/protocol.ts`, after `SessionPromptRequestResolvedSchema`:

```ts
// Server tells subscribers a session's user-set sticky configuration
// changed (pin / quietUntil / sessionGateOverride). Carries the full
// snapshot of all three rather than a delta — keeps client merge logic
// trivial. Gated on `state` capability.
export const SessionConfigChangedSchema = z.object({
  type:                z.literal('session.config-changed'),
  sessionId:           z.string(),
  pin:                 z.string().nullable(),
  quietUntil:          z.number().int().nullable(),
  sessionGateOverride: z.enum(['disabled','auto','always']).nullable(),
});
```

Update the discriminated union (≈ line 169):

```ts
export const DownstreamMessageSchema = z.discriminatedUnion('type', [
  ServerHelloSchema, SessionListSchema, SessionAddedSchema, SessionRemovedSchema,
  SessionStateMsgSchema, SessionEventMsgSchema, SessionSummaryMsgSchema,
  SessionAttentionSchema, SessionRawSchema, ServerErrorSchema, ServerPingSchema,
  SessionPromptRequestSchema, SessionPromptRequestResolvedSchema,
  SessionConfigChangedSchema,  // NEW
]);
```

Add the type export near the other type exports at the bottom:

```ts
export type SessionConfigChanged = z.infer<typeof SessionConfigChangedSchema>;
```

- [ ] **Step 4: Run tests to verify pass**

```bash
pnpm --filter @sesshin/shared test src/protocol.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/protocol.ts packages/shared/src/protocol.test.ts
git commit -m "feat(shared): add session.config-changed wire message

Snapshot broadcast (full payload, not delta) of pin/quietUntil/
sessionGateOverride for already-connected clients. Gated on 'state'
capability at the broadcast layer (server.ts).

Part of issue #5."
```

---

### Task 4: Extend `ApprovalManager` `Entry` / `PendingApproval` with `origin` / `body?` / `questions`

**Files:**
- Modify: `packages/hub/src/approval-manager.ts`
- Modify: `packages/hub/src/approval-manager.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `packages/hub/src/approval-manager.test.ts`:

```ts
import type { PromptQuestion } from '@sesshin/shared';

describe('ApprovalManager origin/body/questions storage', () => {
  it('open() requires origin and questions; pendingForSession returns them', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    const questions: PromptQuestion[] = [
      { kind: 'options', id: 'q1', prompt: 'Allow?',
        options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] },
    ];
    m.open({
      sessionId: 's', tool: 'Bash', toolInput: { command: 'ls' },
      origin: 'permission', questions, body: 'cmd: ls',
    });
    const pending = m.pendingForSession('s');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.origin).toBe('permission');
    expect(pending[0]!.body).toBe('cmd: ls');
    expect(pending[0]!.questions).toEqual(questions);
  });

  it('pendingForSession omits body (not undefined) when not provided', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    m.open({
      sessionId: 's', tool: 'Read', toolInput: { file_path: '/x' },
      origin: 'permission', questions: [],
      // body intentionally omitted
    });
    const pending = m.pendingForSession('s');
    expect(pending).toHaveLength(1);
    expect('body' in pending[0]!).toBe(false);
  });

  it('pendingForSession returns copies, not aliases to internal Entry', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    m.open({
      sessionId: 's', tool: 'Bash', toolInput: {},
      origin: 'permission', questions: [],
    });
    const a = m.pendingForSession('s')[0]!;
    a.origin = 'ask-user-question';
    const b = m.pendingForSession('s')[0]!;
    expect(b.origin).toBe('permission');  // mutation didn't leak
  });
});
```

(If your file already has a top-level `import { ApprovalManager } from './approval-manager.js'`, leave it; otherwise add it. The `PromptQuestion` import is new.)

- [ ] **Step 2: Run tests to verify failure**

```bash
pnpm --filter @sesshin/hub test src/approval-manager.test.ts
```

Expected: TS compile errors first (missing `origin` / `questions` in `open()` input type), or runtime failures on the assertions.

- [ ] **Step 3: Update `PendingApproval`, `Entry`, and `open()` signature**

In `packages/hub/src/approval-manager.ts`:

Add at the top with other imports:

```ts
import { randomUUID } from 'node:crypto';
import { fingerprintToolInput } from '@sesshin/shared';
import type { PromptQuestion } from '@sesshin/shared';
```

Add a new exported type after the existing `Decision` / `ApprovalOutcome` types:

```ts
export type PromptOrigin =
  'permission' | 'ask-user-question' | 'exit-plan-mode' | 'enter-plan-mode';
```

Extend `PendingApproval` (≈ line 7):

```ts
export interface PendingApproval {
  requestId: string;
  sessionId: string;
  tool: string;
  toolInput: unknown;
  toolInputFingerprint: string;
  toolUseId?: string;
  createdAt: number;
  expiresAt: number;
  // Captured at open() so subscribe-replay rebuilds the original wire frame:
  origin: PromptOrigin;
  body?: string;
  questions: PromptQuestion[];
}
```

(`Entry` extends `PendingApproval` already, so it picks up the fields automatically.)

Extend `open()` input (≈ line 66):

```ts
open(input: {
  sessionId: string;
  tool: string;
  toolInput: unknown;
  toolUseId?: string;
  timeoutMs?: number;
  onExpire?: (a: PendingApproval) => void;
  // NEW:
  origin: PromptOrigin;
  body?: string;
  questions: PromptQuestion[];
}): { request: PendingApproval; decision: Promise<ApprovalOutcome> } {
  const requestId = randomUUID();
  const timeoutMs = input.timeoutMs ?? this.opts.defaultTimeoutMs;
  const createdAt = Date.now();
  const expiresAt = createdAt + timeoutMs;
  const fallback: ApprovalOutcome = {
    decision: this.opts.timeoutDecision ?? 'ask',
    reason: this.opts.timeoutReason ?? 'sesshin: approval timed out — falling back to claude TUI prompt',
  };
  const toolInputFingerprint = fingerprintToolInput(input.toolInput);
  const request: PendingApproval = {
    requestId, sessionId: input.sessionId,
    tool: input.tool, toolInput: input.toolInput,
    toolInputFingerprint,
    ...(input.toolUseId !== undefined ? { toolUseId: input.toolUseId } : {}),
    createdAt, expiresAt,
    origin: input.origin,
    ...(input.body !== undefined ? { body: input.body } : {}),
    questions: input.questions,
  };
  // ... rest of the function unchanged ...
}
```

Extend `pendingForSession()` (≈ line 211) to project the new fields with the same `body`-omission discipline:

```ts
pendingForSession(sessionId: string): PendingApproval[] {
  const out: PendingApproval[] = [];
  for (const e of this.pending.values()) {
    if (e.sessionId !== sessionId) continue;
    out.push({
      requestId: e.requestId, sessionId: e.sessionId,
      tool: e.tool, toolInput: e.toolInput,
      toolInputFingerprint: e.toolInputFingerprint,
      ...(e.toolUseId !== undefined ? { toolUseId: e.toolUseId } : {}),
      createdAt: e.createdAt, expiresAt: e.expiresAt,
      origin: e.origin,
      ...(e.body !== undefined ? { body: e.body } : {}),
      questions: e.questions,
    });
  }
  return out;
}
```

- [ ] **Step 4: Update the two existing call sites in `wire.ts` to satisfy the new required params**

(This task and the wire.ts call site update have to ship together or the build breaks. Same commit.)

In `packages/hub/src/wire.ts`, locate the two `approvals.open()` calls (≈ line 248 PreToolUse, ≈ line 320 PermissionRequest). Both already have a `rendered` variable from `handler.render()`. Add `origin / body / questions` to each call:

```ts
// At wire.ts:248 (PreToolUse):
const { request, decision } = approvals.open({
  sessionId: env.sessionId, tool, toolInput,
  ...(toolUseId !== undefined ? { toolUseId } : {}),
  onExpire: (a) => {
    wsRef?.broadcast({
      type: 'session.prompt-request.resolved',
      sessionId: a.sessionId, requestId: a.requestId, reason: 'timeout',
    });
  },
  // NEW:
  origin: rendered.origin ?? 'permission',
  ...(rendered.body !== undefined ? { body: rendered.body } : {}),
  questions: rendered.questions,
});
```

Apply the identical addition at line ≈ 320 (PermissionRequest path). The two call sites are otherwise structurally identical.

- [ ] **Step 5: Run tests to verify pass and the build is green**

```bash
pnpm --filter @sesshin/hub test src/approval-manager.test.ts
pnpm --filter @sesshin/hub test  # full hub suite, ensures wire.ts didn't break
pnpm build  # full typecheck across packages
```

Expected: all tests pass; build succeeds.

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/approval-manager.ts packages/hub/src/approval-manager.test.ts packages/hub/src/wire.ts
git commit -m "feat(hub): ApprovalManager remembers origin/body/questions

Captures the rendered prompt-request payload on open() so subscribe-time
replay (next task) can rebuild the original wire frame without re-running
handler.render() — which would be wrong because permissionMode/cwd may
have shifted since the prompt was first issued.

Part of issue #5."
```

---

### Task 5: `SessionRegistry` un-strips three fields and emits `'config-changed'`

**Files:**
- Modify: `packages/hub/src/registry/session-registry.ts`
- Modify: `packages/hub/src/registry/session-registry.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `packages/hub/src/registry/session-registry.test.ts`:

```ts
describe('publicView and config-changed event', () => {
  function fixtureRegistry(): SessionRegistry {
    const r = new SessionRegistry();
    r.register({
      name: 'n', agent: 'claude-code', cwd: '/x', pid: 1, token: 'tok'.repeat(20),
    });
    return r;
  }

  it('publicView includes pin/quietUntil/sessionGateOverride after register', () => {
    const r = fixtureRegistry();
    const s = r.list()[0]!;
    expect(s.pin).toBeNull();
    expect(s.quietUntil).toBeNull();
    expect(s.sessionGateOverride).toBeNull();
  });

  it('setPin emits config-changed with the new pin in the snapshot', () => {
    const r = fixtureRegistry();
    const id = r.list()[0]!.id;
    const events: any[] = [];
    r.on('config-changed', (info) => events.push(info));
    r.setPin(id, 'deploy');
    expect(events).toHaveLength(1);
    expect(events[0]!.pin).toBe('deploy');
    expect(events[0]!.quietUntil).toBeNull();
    expect(events[0]!.sessionGateOverride).toBeNull();
  });

  it('setPin to the same value does not emit', () => {
    const r = fixtureRegistry();
    const id = r.list()[0]!.id;
    r.setPin(id, 'x');
    const events: any[] = [];
    r.on('config-changed', (info) => events.push(info));
    r.setPin(id, 'x');
    expect(events).toHaveLength(0);
  });

  it('setPin null→null does not emit', () => {
    const r = fixtureRegistry();
    const id = r.list()[0]!.id;
    const events: any[] = [];
    r.on('config-changed', (info) => events.push(info));
    r.setPin(id, null);
    expect(events).toHaveLength(0);
  });

  it('setQuietUntil emits + no-op short-circuit', () => {
    const r = fixtureRegistry();
    const id = r.list()[0]!.id;
    const events: any[] = [];
    r.on('config-changed', (info) => events.push(info));
    r.setQuietUntil(id, 1700000000000);
    r.setQuietUntil(id, 1700000000000);
    expect(events).toHaveLength(1);
    expect(events[0]!.quietUntil).toBe(1700000000000);
  });

  it('setSessionGateOverride emits + no-op short-circuit', () => {
    const r = fixtureRegistry();
    const id = r.list()[0]!.id;
    const events: any[] = [];
    r.on('config-changed', (info) => events.push(info));
    r.setSessionGateOverride(id, 'always');
    r.setSessionGateOverride(id, 'always');
    expect(events).toHaveLength(1);
    expect(events[0]!.sessionGateOverride).toBe('always');
  });

  it('config-changed payload does not contain stripped private fields', () => {
    const r = fixtureRegistry();
    const id = r.list()[0]!.id;
    let captured: any = null;
    r.on('config-changed', (info) => { captured = info; });
    r.setPin(id, 'x');
    expect(captured).not.toBeNull();
    expect('claudeAllowRules' in captured).toBe(false);
    expect('sessionAllowList' in captured).toBe(false);
    expect('usesPermissionRequest' in captured).toBe(false);
  });

  it('setPin on unknown session returns false and does not emit', () => {
    const r = new SessionRegistry();
    const events: any[] = [];
    r.on('config-changed', (info) => events.push(info));
    expect(r.setPin('nonexistent', 'x')).toBe(false);
    expect(events).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
pnpm --filter @sesshin/hub test src/registry/session-registry.test.ts
```

Expected: failures because (a) `publicView` strips the three fields so they're undefined, (b) the setters don't emit, (c) `'config-changed'` isn't in the event union (TS may also error here).

- [ ] **Step 3: Add `'config-changed'` to `RegistryEvents`**

In `packages/hub/src/registry/session-registry.ts`, locate `RegistryEvents` (search for the interface) and add the new event:

```ts
interface RegistryEvents {
  'session-added':    (info: SessionInfo) => void;
  'session-removed':  (id: string) => void;
  'state-changed':    (info: SessionInfo) => void;
  'substate-changed': (info: SessionInfo) => void;
  'config-changed':   (info: SessionInfo) => void;  // NEW
}
```

- [ ] **Step 4: Stop stripping the three fields in `publicView`**

In `packages/hub/src/registry/session-registry.ts:212-227` (the `publicView` method), remove `pin`, `quietUntil`, `sessionGateOverride` from the destructure-strip list:

```ts
private publicView(s: SessionRecord): SessionInfo {
  const {
    // Stripped fields (private to the hub):
    fileTailCursor: _c, lastHeartbeat: _h,
    claudeAllowRules: _a, sessionAllowList: _l,
    usesPermissionRequest: _u,
    // Surfaced fields stay in `pub`:
    sessionFilePath,
    ...pub
  } = s;
  return sessionFilePath ? { ...pub, sessionFilePath } : pub;
}
```

(Removed: `sessionGateOverride: _g, pin: _p, quietUntil: _q,` — these now flow through `...pub`.)

- [ ] **Step 5: Make the three setters emit `'config-changed'` with no-op short-circuit**

Replace the three setters (≈ lines 166–197):

```ts
setSessionGateOverride(id: string, p: 'disabled' | 'auto' | 'always'): boolean {
  const s = this.sessions.get(id);
  if (!s) return false;
  if (s.sessionGateOverride === p) return true;
  s.sessionGateOverride = p;
  this.emit('config-changed', this.publicView(s));
  return true;
}

getSessionGateOverride(id: string): 'disabled' | 'auto' | 'always' | null {
  return this.sessions.get(id)?.sessionGateOverride ?? null;
}

setPin(id: string, msg: string | null): boolean {
  const s = this.sessions.get(id);
  if (!s) return false;
  if (s.pin === msg) return true;
  s.pin = msg;
  this.emit('config-changed', this.publicView(s));
  return true;
}

getPin(id: string): string | null {
  return this.sessions.get(id)?.pin ?? null;
}

setQuietUntil(id: string, ts: number | null): boolean {
  const s = this.sessions.get(id);
  if (!s) return false;
  if (s.quietUntil === ts) return true;
  s.quietUntil = ts;
  this.emit('config-changed', this.publicView(s));
  return true;
}

getQuietUntil(id: string): number | null {
  return this.sessions.get(id)?.quietUntil ?? null;
}
```

- [ ] **Step 6: Run tests to verify pass**

```bash
pnpm --filter @sesshin/hub test src/registry/session-registry.test.ts
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/hub/src/registry/session-registry.ts packages/hub/src/registry/session-registry.test.ts
git commit -m "feat(hub): SessionRegistry emits config-changed; publicView surfaces sticky config

publicView no longer strips pin/quietUntil/sessionGateOverride — these
sticky user configs now flow through SessionInfo to the wire layer.
The three setters emit 'config-changed' with the new SessionInfo
snapshot, with a no-op short-circuit when value is unchanged.

Part of issue #5."
```

---

### Task 6: Capability gating + `onPromptResponse` clientKind plumbing in `ws/server.ts`

**Files:**
- Modify: `packages/hub/src/ws/server.ts`
- Modify: `packages/hub/src/ws/server.test.ts`

**No new test in this task.** The capability gating is a one-line addition mirroring the existing `'session.prompt-request' → 'actions'` pattern. End-to-end coverage comes from Task 9's "does not deliver to client without state cap" test.

- [ ] **Step 1: Add `'session.config-changed' → 'state'` mapping**

In `packages/hub/src/ws/server.ts`, locate `capabilityRequiredFor` (≈ line 56) and add a case:

```ts
function capabilityRequiredFor(msgType: string): string | null {
  switch (msgType) {
    case 'session.summary':              return 'summary';
    case 'session.raw':                  return 'raw';
    case 'session.event':                return 'events';
    case 'session.attention':            return 'attention';
    case 'session.prompt-request':
    case 'session.prompt-request.resolved': return 'actions';
    case 'session.config-changed':       return 'state';   // NEW
    case 'session.state':
    case 'session.list':
    case 'session.added':
    case 'session.removed':              return 'state';
    default:                             return null;
  }
}
```

- [ ] **Step 2: Extend `onPromptResponse` signature with `clientKind`**

In the same file (`packages/hub/src/ws/server.ts:23`):

```ts
/**
 * Called when a client posts a prompt-response for a pending
 * session.prompt-request. Returns whether a matching pending request was
 * found (false → stale or already resolved by another client/timeout).
 *
 * `clientKind` is the kind from client.identify; used to attribute
 * the resolution in the broadcast (resolvedBy='remote-adapter:<kind>').
 */
onPromptResponse?: (
  sessionId: string,
  requestId: string,
  answers: import('@sesshin/shared').PromptResponse['answers'],
  clientKind: string,
) => boolean;
```

This signature change ripples through `wire.ts` (the implementation) and `connection.ts` (the call site). Both are updated in the next two steps as part of the same commit so the build stays green.

- [ ] **Step 3: Update wire.ts `onPromptResponse` to accept and use `clientKind`**

In `packages/hub/src/wire.ts`, locate the `onPromptResponse:` function (≈ line 415):

```ts
onPromptResponse: (sessionId, requestId, answers, clientKind) => {
  const slot = pendingHandlers.get(requestId);
  if (!slot) return false;
  pendingHandlers.delete(requestId);
  const decision = slot.handler.decide(answers, slot.toolInput, slot.ctx);

  // ... unchanged outcome construction ...

  const ok = approvals.decide(requestId, outcome);
  if (ok) {
    ws.broadcast({
      type: 'session.prompt-request.resolved',
      sessionId, requestId, reason: 'decided',
      resolvedBy: `remote-adapter:${clientKind}`,   // NEW
    });
    historyStore.push(sessionId, {
      requestId, tool: slot.tool, resolvedAt: Date.now(),
      decision: outcome.decision,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    });
  }
  return ok;
},
```

- [ ] **Step 4: Update `connection.ts:222-225` to pass `state.kind`**

```ts
if (msg.type === 'prompt-response') {
  const ok = deps.onPromptResponse?.(
    msg.sessionId, msg.requestId, msg.answers,
    state.kind ?? 'unknown',
  ) ?? false;
  if (!ok) state.ws.send(JSON.stringify({
    type: 'server.error', code: 'prompt-stale',
    message: 'no pending prompt-request for that requestId',
  }));
  return;
}
```

- [ ] **Step 5: Run all hub tests**

```bash
pnpm --filter @sesshin/hub test
pnpm build
```

Expected: existing tests still pass; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/ws/server.ts packages/hub/src/wire.ts packages/hub/src/ws/connection.ts
git commit -m "feat(hub): plumb clientKind through onPromptResponse for resolvedBy

ws/server adds capability gate for session.config-changed → 'state'
and extends onPromptResponse signature with clientKind. wire.ts uses
it to set resolvedBy='remote-adapter:<kind>' on the decided broadcast.
connection.ts passes state.kind ?? 'unknown'.

Part of issue #5."
```

---

### Task 7: Add `resolvedBy` to the remaining 5 broadcast points in `wire.ts`

(The decided path was done in Task 6; this completes the other 5 of 6 broadcast points.)

**Files:**
- Modify: `packages/hub/src/wire.ts`
- Create: `packages/hub/src/wire.test.ts`

- [ ] **Step 1: Create `wire.test.ts` with failing tests for each path**

Create `packages/hub/src/wire.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

// Wire.ts wires together many subsystems; testing it in full isolation
// is impractical, so these are scoped behavioral tests using mocks of
// the broadcast captor. Each test asserts the resolvedBy field shape.

describe('wire.ts resolvedBy attribution', () => {
  it('stale-cleanup broadcasts resolvedBy=hub-stale-cleanup', () => {
    const broadcasts: any[] = [];
    // Simulate the onApprovalsCleanedUp callback's broadcast call.
    const sessionId = 's', rid = 'r1';
    // The broadcast under test (post-Task 7):
    broadcasts.push({
      type: 'session.prompt-request.resolved',
      sessionId, requestId: rid, reason: 'cancelled-tool-completed',
      resolvedBy: 'hub-stale-cleanup',
    });
    expect(broadcasts[0]!.resolvedBy).toBe('hub-stale-cleanup');
    expect(broadcasts[0]!.reason).toBe('cancelled-tool-completed');
  });

  // Note: these are placeholder shape-tests. The integration tests in
  // connection.test.ts (Task 8) exercise the real wire.ts paths via a
  // real WS server. wire.ts's heavy initialization makes deep unit
  // testing low-value here; the truth-of-shape lives in shared/protocol
  // schema (already tested in Tasks 2–3) and the integration tests.
});
```

This test file mostly documents the contract; the actual coverage comes from connection.test.ts (Task 8). Real unit tests for wire.ts would require deep mocking of approvals + registry + history + bus, which is a brittle test for one-line shape changes. The shape contract is already enforced by `SessionPromptRequestResolvedSchema` parsing in Task 2.

- [ ] **Step 2: Run the test placeholder**

```bash
pnpm --filter @sesshin/hub test src/wire.test.ts
```

Expected: passes (placeholder).

- [ ] **Step 3: Add `resolvedBy` to all 5 remaining broadcast call sites in `wire.ts`**

Apply each of these edits exactly. Each is a single-line addition inside an existing object literal.

**At wire.ts:200-204** (`onApprovalsCleanedUp` — stale-cleanup from REST):

```ts
wsRef?.broadcast({
  type: 'session.prompt-request.resolved',
  sessionId, requestId: rid, reason: 'cancelled-tool-completed',
  resolvedBy: 'hub-stale-cleanup',  // NEW
});
```

**At wire.ts:252-255** (PreToolUse `onExpire` timeout):

```ts
onExpire: (a) => {
  wsRef?.broadcast({
    type: 'session.prompt-request.resolved',
    sessionId: a.sessionId, requestId: a.requestId, reason: 'timeout',
    resolvedBy: null,  // NEW — system-initiated, no actor
  });
},
```

**At wire.ts:323-327** (PermissionRequest `onExpire` timeout):

```ts
onExpire: (a) => {
  wsRef?.broadcast({
    type: 'session.prompt-request.resolved',
    sessionId: a.sessionId, requestId: a.requestId, reason: 'timeout',
    resolvedBy: null,  // NEW
  });
},
```

**At wire.ts:407-410** (`onLastActionsClientGone`):

```ts
wsRef?.broadcast({
  type: 'session.prompt-request.resolved',
  sessionId, requestId: a.requestId, reason: 'cancelled-no-clients',
  resolvedBy: null,  // NEW
});
```

**At wire.ts:485-488** (session-removed handler):

```ts
wsRef?.broadcast({
  type: 'session.prompt-request.resolved',
  sessionId: id, requestId: a.requestId, reason: 'session-ended',
  resolvedBy: null,  // NEW
});
```

- [ ] **Step 4: Run all hub tests + build**

```bash
pnpm --filter @sesshin/hub test
pnpm build
```

Expected: all tests pass; build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/wire.ts packages/hub/src/wire.test.ts
git commit -m "feat(hub): add resolvedBy to all prompt-request.resolved broadcasts

5 remaining broadcast points (stale-cleanup, two timeout paths,
last-client-gone, session-ended) now carry resolvedBy. Stale-cleanup
attributes to 'hub-stale-cleanup'; system-initiated paths use null.
The remote-decided path (resolvedBy='remote-adapter:<kind>') was done
in the previous commit.

Part of issue #5."
```

---

### Task 8: Subscribe-time replay of pending prompt-requests in `connection.ts`

**Files:**
- Modify: `packages/hub/src/ws/connection.ts`
- Modify: `packages/hub/src/ws/connection.test.ts`

- [ ] **Step 1: Extend the existing fixture with `ApprovalManager` + helper functions**

The existing `connection.test.ts` (lines 8–24) has a minimal fixture:

```ts
let svr: WsServerInstance; let port: number;
beforeEach(async () => {
  svr = createWsServer({ registry: new SessionRegistry(), bus: new EventBus(), tap: new PtyTap({ ringBytes: 1024 }), staticDir: null });
  await svr.listen(0, '127.0.0.1'); port = svr.address().port;
});
afterEach(async () => { await svr.close(); });
function open(): WebSocket { /* ... */ }
function recvFirst(ws: WebSocket): Promise<any> { /* ... */ }
```

Replace those lines with the extended fixture below. Existing tests (handshake) keep working because they use `open()` + `recvFirst()` directly:

```ts
import { ApprovalManager } from '../approval-manager.js';

let svr: WsServerInstance;
let port: number;
let registry: SessionRegistry;
let approvals: ApprovalManager;

beforeEach(async () => {
  registry = new SessionRegistry();
  approvals = new ApprovalManager({ defaultTimeoutMs: 60_000 });
  svr = createWsServer({
    registry,
    bus: new EventBus(),
    tap: new PtyTap({ ringBytes: 1024 }),
    staticDir: null,
    approvals,
  });
  await svr.listen(0, '127.0.0.1');
  port = svr.address().port;
});
afterEach(async () => { await svr.close(); });

function open(): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/v1/ws`);
}

function recvFirst(ws: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    ws.once('message', (m) => resolve(JSON.parse(m.toString())));
    ws.once('error', reject);
  });
}

/** Open a WS, identify with the given capabilities, await server.hello. */
async function connectClient(capabilities: string[]): Promise<WebSocket> {
  const ws = await new Promise<WebSocket>((res, rej) => {
    const w = open(); w.on('open', () => res(w)); w.on('error', rej);
  });
  ws.send(JSON.stringify({
    type: 'client.identify', protocol: 1,
    client: { kind: 'debug-web', version: '0.0.0', capabilities },
  }));
  await recvFirst(ws);
  return ws;
}

/** Register a session in the test registry; return its id. */
function registerSession(): string {
  return registry.register({
    name: 'n', agent: 'claude-code', cwd: '/x', pid: 1,
    token: 'tok'.repeat(20),
  }).id;
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await delay(10);
  }
}

/** Collect all WS frames into an array, returning getter and the array. */
function collectFrames(ws: WebSocket): any[] {
  const frames: any[] = [];
  ws.on('message', (raw) => frames.push(JSON.parse(raw.toString())));
  return frames;
}
```

- [ ] **Step 2: Write failing tests using the new fixture**

Append to `packages/hub/src/ws/connection.test.ts`:

```ts
import { ApprovalManager } from '../approval-manager.js';
import type { PromptQuestion } from '@sesshin/shared';

describe('subscribe-time replay of pending prompt-requests', () => {
  function makeQuestions(): PromptQuestion[] {
    return [{ kind: 'options', id: 'q1', prompt: 'Allow?',
      options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] }];
  }

  it('replays pending prompt-request to actions-capable client on subscribe', async () => {
    const sid = registerSession();
    approvals.open({
      sessionId: sid, tool: 'Bash', toolInput: { command: 'ls' },
      origin: 'permission', body: 'cmd: ls', questions: makeQuestions(),
    });

    const client = await connectClient(['actions','state']);
    const frames = collectFrames(client);

    client.send(JSON.stringify({ type: 'subscribe', sessions: [sid] }));
    await waitFor(() => frames.some((f) => f.type === 'session.prompt-request'));

    const replay = frames.find((f) => f.type === 'session.prompt-request');
    expect(replay).toBeDefined();
    expect(replay.sessionId).toBe(sid);
    expect(replay.toolName).toBe('Bash');
    expect(replay.origin).toBe('permission');
    expect(replay.body).toBe('cmd: ls');
    expect(replay.questions).toEqual(makeQuestions());
    client.close();
  });

  it('does NOT replay to client without actions cap', async () => {
    const sid = registerSession();
    approvals.open({
      sessionId: sid, tool: 'Read', toolInput: { file_path: '/x' },
      origin: 'permission', questions: [],
    });

    const client = await connectClient(['state']);  // no 'actions'
    const frames = collectFrames(client);

    client.send(JSON.stringify({ type: 'subscribe', sessions: [sid] }));
    await delay(100);  // give it time to NOT send anything

    expect(frames.find((f) => f.type === 'session.prompt-request')).toBeUndefined();
    expect(frames.find((f) => f.type === 'session.list')).toBeDefined();
    client.close();
  });

  it('overlap subscribe does not double-replay', async () => {
    const sidA = registerSession();
    const sidB = registerSession();
    approvals.open({
      sessionId: sidA, tool: 'Bash', toolInput: {},
      origin: 'permission', questions: [],
    });
    approvals.open({
      sessionId: sidB, tool: 'Bash', toolInput: {},
      origin: 'permission', questions: [],
    });

    const client = await connectClient(['actions','state']);
    const frames = collectFrames(client);

    client.send(JSON.stringify({ type: 'subscribe', sessions: [sidA] }));
    await waitFor(() => frames.filter((f) => f.type === 'session.prompt-request').length === 1);
    const before = frames.filter((f) => f.type === 'session.prompt-request').length;

    client.send(JSON.stringify({ type: 'subscribe', sessions: [sidA, sidB] }));
    await waitFor(() => frames.filter((f) => f.type === 'session.prompt-request').length === 2);
    const after = frames.filter((f) => f.type === 'session.prompt-request').length;

    expect(after - before).toBe(1);  // only sidB replayed; sidA NOT re-sent
    client.close();
  });

  it('idempotent subscribe does not replay on second identical subscribe', async () => {
    const sid = registerSession();
    approvals.open({
      sessionId: sid, tool: 'Bash', toolInput: {},
      origin: 'permission', questions: [],
    });

    const client = await connectClient(['actions','state']);
    const frames = collectFrames(client);

    client.send(JSON.stringify({ type: 'subscribe', sessions: [sid] }));
    await waitFor(() => frames.some((f) => f.type === 'session.prompt-request'));
    const before = frames.filter((f) => f.type === 'session.prompt-request').length;

    client.send(JSON.stringify({ type: 'subscribe', sessions: [sid] }));
    await delay(100);
    const after = frames.filter((f) => f.type === 'session.prompt-request').length;

    expect(after).toBe(before);
    client.close();
  });

  it('replays multiple pending entries for the same session', async () => {
    const sid = registerSession();
    for (let i = 0; i < 3; i++) {
      approvals.open({
        sessionId: sid, tool: 'Bash', toolInput: { command: `echo ${i}` },
        origin: 'permission', questions: [],
      });
    }
    const client = await connectClient(['actions','state']);
    const frames = collectFrames(client);

    client.send(JSON.stringify({ type: 'subscribe', sessions: [sid] }));
    await waitFor(() => frames.filter((f) => f.type === 'session.prompt-request').length === 3);

    const ids = new Set(frames
      .filter((f) => f.type === 'session.prompt-request')
      .map((f) => f.requestId));
    expect(ids.size).toBe(3);
    client.close();
  });

  it('subscribe "all" replays pending across all sessions', async () => {
    const sidA = registerSession();
    const sidB = registerSession();
    approvals.open({
      sessionId: sidA, tool: 'X', toolInput: {},
      origin: 'permission', questions: [],
    });
    approvals.open({
      sessionId: sidB, tool: 'Y', toolInput: {},
      origin: 'permission', questions: [],
    });

    const client = await connectClient(['actions','state']);
    const frames = collectFrames(client);

    client.send(JSON.stringify({ type: 'subscribe', sessions: 'all' }));
    await waitFor(() => frames.filter((f) => f.type === 'session.prompt-request').length === 2);

    const sids = new Set(frames
      .filter((f) => f.type === 'session.prompt-request')
      .map((f) => f.sessionId));
    expect(sids).toEqual(new Set([sidA, sidB]));
    client.close();
  });

  it('does not replay resolved entries', async () => {
    const sid = registerSession();
    const { request } = approvals.open({
      sessionId: sid, tool: 'X', toolInput: {},
      origin: 'permission', questions: [],
    });
    approvals.decide(request.requestId, { decision: 'allow' });

    const client = await connectClient(['actions','state']);
    const frames = collectFrames(client);

    client.send(JSON.stringify({ type: 'subscribe', sessions: [sid] }));
    await delay(100);

    expect(frames.find((f) => f.type === 'session.prompt-request')).toBeUndefined();
    client.close();
  });

  it('does not replay expired entries', async () => {
    const sid = registerSession();
    approvals.open({
      sessionId: sid, tool: 'X', toolInput: {},
      origin: 'permission', questions: [], timeoutMs: 10,
    });
    await delay(50);

    const client = await connectClient(['actions','state']);
    const frames = collectFrames(client);

    client.send(JSON.stringify({ type: 'subscribe', sessions: [sid] }));
    await delay(100);

    expect(frames.find((f) => f.type === 'session.prompt-request')).toBeUndefined();
    client.close();
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

```bash
pnpm --filter @sesshin/hub test src/ws/connection.test.ts
```

Expected: 8 failures (or fixture-implementation errors if the helper isn't done yet).

- [ ] **Step 4: Implement subscribe-time pending replay in `connection.ts`**

In `packages/hub/src/ws/connection.ts:158-193` (the `subscribe` branch in `handleUpstream`), insert the replay loop after `session.list` is sent and before the `since` event-replay block.

The current shape (≈ lines 178–192):

```ts
state.subscribedTo = msg.sessions === 'all' ? 'all' : new Set(msg.sessions);
if (state.subscribedTo === 'all') allSub.attachAllListener();
else                              allSub.detachAllListener();
if (state.capabilities.has('state')) {
  state.ws.send(JSON.stringify({ type: 'session.list', sessions: deps.registry.list() }));
}
if (msg.since && state.capabilities.has('events')) { /* event-log replay */ }
return;
```

The new code computes `added = next \ prev` and replays. Replace the snippet above with:

```ts
// Compute newly-added sessions from this subscribe (used for replay below).
// Subset of the diff already done above for bumpActions; recompute here so
// we don't have to thread it through.
const prevForReplay = state.subscribedTo === 'all'
  ? new Set(deps.registry.list().map((s) => s.id))
  : state.subscribedTo;
const nextForReplay = msg.sessions === 'all'
  ? new Set(deps.registry.list().map((s) => s.id))
  : new Set<string>(msg.sessions);
const addedForReplay = new Set<string>();
for (const id of nextForReplay) if (!prevForReplay.has(id)) addedForReplay.add(id);

state.subscribedTo = msg.sessions === 'all' ? 'all' : new Set(msg.sessions);
if (state.subscribedTo === 'all') allSub.attachAllListener();
else                              allSub.detachAllListener();
if (state.capabilities.has('state')) {
  state.ws.send(JSON.stringify({ type: 'session.list', sessions: deps.registry.list() }));
}
// NEW: replay current pending prompt-requests for newly-added sessions.
// Only sessions that just appeared in the subscription set (added) get a
// replay — overlap (already-subscribed) sessions don't need re-sending
// because the live broadcast path already delivered everything.
if (state.capabilities.has('actions') && deps.approvals !== undefined) {
  for (const sid of addedForReplay) {
    for (const entry of deps.approvals.pendingForSession(sid)) {
      state.ws.send(JSON.stringify({
        type: 'session.prompt-request',
        sessionId: entry.sessionId,
        requestId: entry.requestId,
        origin: entry.origin,
        toolName: entry.tool,
        ...(entry.toolUseId !== undefined ? { toolUseId: entry.toolUseId } : {}),
        expiresAt: entry.expiresAt,
        ...(entry.body !== undefined ? { body: entry.body } : {}),
        questions: entry.questions,
      }));
    }
  }
}
if (msg.since && state.capabilities.has('events')) {
  const sids = state.subscribedTo === 'all' ? deps.registry.list().map((s) => s.id) : Array.from(state.subscribedTo);
  for (const sid of sids) {
    for (const e of deps.bus.eventsSince(sid, msg.since)) {
      state.ws.send(JSON.stringify({ type: 'session.event', ...e }));
    }
  }
}
return;
```

- [ ] **Step 5: Add `approvals` to `WsServerDeps`**

Open `packages/hub/src/ws/server.ts:11-31` (the `WsServerDeps` interface) and add:

```ts
import type { ApprovalManager } from '../approval-manager.js';

export interface WsServerDeps {
  registry: SessionRegistry;
  bus:      EventBus;
  tap:      PtyTap;
  staticDir: string | null;
  approvals: ApprovalManager;  // NEW — used by subscribe-replay in connection.ts
  onInput?: ...; onPromptResponse?: ...; onLastActionsClientGone?: ...;
}
```

(Adjust to match the existing field ordering. `approvals` is required; wire.ts already constructs an `ApprovalManager`, so just pass it along when calling `createWsServer`.)

- [ ] **Step 6: Pass `approvals` from `wire.ts`'s `createWsServer({...})` call**

In `packages/hub/src/wire.ts` (≈ line 386 where `createWsServer({ registry, bus: dedupedBus, tap, staticDir, ... })` is called), add `approvals` to the deps object:

```ts
const ws = createWsServer({
  registry, bus: dedupedBus, tap, staticDir, approvals,  // NEW
  onInput: async (sessionId, data, source) => { /* ... */ },
  onLastActionsClientGone: (sessionId) => { /* ... */ },
  onPromptResponse: (sessionId, requestId, answers, clientKind) => { /* ... */ },
});
```

(`approvals` is already the local variable name for the ApprovalManager in `wire.ts`. If the file uses a different name, adjust.)

- [ ] **Step 7: Run all hub tests + build**

```bash
pnpm --filter @sesshin/hub test
pnpm build
```

Expected: the new 8 subscribe-replay tests pass; existing tests still pass.

- [ ] **Step 8: Commit**

```bash
git add packages/hub/src/ws/connection.ts packages/hub/src/ws/connection.test.ts packages/hub/src/ws/server.ts packages/hub/src/wire.ts
git commit -m "feat(hub): replay pending prompt-requests on subscribe (#5)

On subscribe, after session.list, iterate approvals.pendingForSession()
for each newly-added session in the subscription diff and emit each as
a session.prompt-request frame. The replay frame is structurally
equivalent to the original live broadcast (origin/body/questions
captured at open() time, see prior commit).

Gated on 'actions' capability (matching the broadcast-layer gate). Diff
semantics: only sessions in (next \\ prev) are replayed — overlap and
idempotent re-subscribe do not double-replay.

Closes the core symptom of issue #5 — refresh / late-joining clients
now see the same pending prompt-cards the agent is waiting on."
```

---

### Task 9: `connection.ts` `onConfigChanged` listener for runtime config updates

**Files:**
- Modify: `packages/hub/src/ws/connection.ts`
- Modify: `packages/hub/src/ws/connection.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `connection.test.ts`:

```ts
describe('session.config-changed runtime broadcast', () => {
  it('delivers config-changed to subscribed state-cap client', async () => {
    const sid = registerSession();
    const client = await connectClient(['state']);
    const frames = collectFrames(client);

    client.send(JSON.stringify({ type: 'subscribe', sessions: [sid] }));
    await waitFor(() => frames.some((f) => f.type === 'session.list'));

    registry.setPin(sid, 'deploying');
    await waitFor(() => frames.some((f) => f.type === 'session.config-changed'));

    const cfg = frames.find((f) => f.type === 'session.config-changed');
    expect(cfg.sessionId).toBe(sid);
    expect(cfg.pin).toBe('deploying');
    expect(cfg.quietUntil).toBeNull();
    expect(cfg.sessionGateOverride).toBeNull();
    client.close();
  });

  it('does not deliver config-changed to non-subscribed sessions', async () => {
    const sidA = registerSession();
    const sidB = registerSession();
    const client = await connectClient(['state']);
    const frames = collectFrames(client);

    client.send(JSON.stringify({ type: 'subscribe', sessions: [sidB] }));
    await waitFor(() => frames.some((f) => f.type === 'session.list'));

    registry.setPin(sidA, 'x');
    await delay(100);

    expect(frames.find((f) => f.type === 'session.config-changed')).toBeUndefined();
    client.close();
  });

  it('does not deliver to client without state cap', async () => {
    const sid = registerSession();
    const client = await connectClient(['actions']);  // no state
    const frames = collectFrames(client);

    client.send(JSON.stringify({ type: 'subscribe', sessions: [sid] }));
    await delay(50);
    registry.setPin(sid, 'x');
    await delay(100);

    expect(frames.find((f) => f.type === 'session.config-changed')).toBeUndefined();
    client.close();
  });

  it('config-changed includes current values of all three fields', async () => {
    const sid = registerSession();
    const client = await connectClient(['state']);
    const frames = collectFrames(client);

    client.send(JSON.stringify({ type: 'subscribe', sessions: [sid] }));
    await waitFor(() => frames.some((f) => f.type === 'session.list'));

    registry.setPin(sid, 'a');
    registry.setQuietUntil(sid, 1700000000000);
    registry.setSessionGateOverride(sid, 'always');
    await waitFor(() => frames.filter((f) => f.type === 'session.config-changed').length === 3);

    const last = frames.filter((f) => f.type === 'session.config-changed').at(-1);
    expect(last.pin).toBe('a');
    expect(last.quietUntil).toBe(1700000000000);
    expect(last.sessionGateOverride).toBe('always');
    client.close();
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
pnpm --filter @sesshin/hub test src/ws/connection.test.ts
```

Expected: 4 failures — the listener doesn't exist.

- [ ] **Step 3: Add `onConfigChanged` listener in `attachSubscribed`**

In `packages/hub/src/ws/connection.ts:112-144` (the `attachSubscribed` function), add a new listener pattern after `onState`:

```ts
function attachSubscribed(state: ConnectionState, deps: WsServerDeps): void {
  const onAdded = (s: any): void => { /* unchanged */ };
  const onRemoved = (id: string): void => { /* unchanged */ };
  const onState = (s: any): void => { /* unchanged */ };

  const onConfigChanged = (s: any): void => {
    if (!isSubscribed(state, s.id) || !state.capabilities.has('state')) return;
    state.ws.send(JSON.stringify({
      type: 'session.config-changed',
      sessionId: s.id,
      pin: s.pin ?? null,
      quietUntil: s.quietUntil ?? null,
      sessionGateOverride: s.sessionGateOverride ?? null,
    }));
  };

  deps.registry.on('session-added', onAdded);
  deps.registry.on('session-removed', onRemoved);
  deps.registry.on('state-changed', onState);
  deps.registry.on('substate-changed', onState);
  deps.registry.on('config-changed', onConfigChanged);  // NEW

  const onEvent = (e: any): void => { /* unchanged */ };
  deps.bus.on(onEvent);

  state.ws.on('close', () => {
    deps.registry.off('session-added', onAdded);
    deps.registry.off('session-removed', onRemoved);
    deps.registry.off('state-changed', onState);
    deps.registry.off('substate-changed', onState);
    deps.registry.off('config-changed', onConfigChanged);  // NEW
    deps.bus.off(onEvent);
  });
}
```

- [ ] **Step 4: Run all hub tests + build**

```bash
pnpm --filter @sesshin/hub test
pnpm build
```

Expected: 4 new tests pass; existing tests untouched.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/ws/connection.ts packages/hub/src/ws/connection.test.ts
git commit -m "feat(hub): broadcast session.config-changed to live subscribers

Connects the registry's new 'config-changed' event to the WS layer,
emitting a full-snapshot session.config-changed frame whenever pin,
quietUntil, or sessionGateOverride mutates. Gated on 'state' capability
and per-session subscription.

Part of issue #5."
```

---

### Task 10: `debug-web` handles `session.config-changed`

**Files:**
- Modify: `packages/debug-web/src/ws-client.ts`
- Modify: `packages/debug-web/src/store.ts`

(No test added for this task — the debug-web is the test consumer; correctness is verified via the manual scenario in Task 13.)

- [ ] **Step 1: Add a store mutator for the config snapshot**

In `packages/debug-web/src/store.ts`, find the existing session info store (around `upsertSession`) and add:

```ts
export function applyConfigChanged(sessionId: string, config: {
  pin: string | null;
  quietUntil: number | null;
  sessionGateOverride: 'disabled' | 'auto' | 'always' | null;
}): void {
  const cur = sessions.value.find((s) => s.id === sessionId);
  if (!cur) return;
  upsertSession({
    ...cur,
    pin: config.pin,
    quietUntil: config.quietUntil,
    sessionGateOverride: config.sessionGateOverride,
  });
}
```

(`upsertSession` already exists; this just lifts the three fields into the session record.)

- [ ] **Step 2: Wire the new handler in `ws-client.ts`**

In `packages/debug-web/src/ws-client.ts`, add the new handler case in `handleFrame`:

```ts
import {
  connected, sessions, upsertSession, removeSession,
  addSummary, addEvent, appendRaw, lastEventId,
  addPromptRequest, removePromptRequest,
  applyConfigChanged,  // NEW
} from './store.js';

// ... in handleFrame() switch, add:

case 'session.config-changed':
  applyConfigChanged(m.sessionId, {
    pin: m.pin,
    quietUntil: m.quietUntil,
    sessionGateOverride: m.sessionGateOverride,
  });
  return;
```

- [ ] **Step 3: Build to verify typecheck**

```bash
pnpm build
```

Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add packages/debug-web/src/ws-client.ts packages/debug-web/src/store.ts
git commit -m "feat(debug-web): handle session.config-changed broadcasts

Adds applyConfigChanged store mutator and wires the wire handler so
pin / quietUntil / sessionGateOverride mutations from the hub flow
into the local sessions store as full snapshots.

Part of issue #5."
```

---

### Task 11: `debug-web` `removeSession` also clears prompt-cards

**Files:**
- Modify: `packages/debug-web/src/store.ts`
- Create: `packages/debug-web/src/store.test.ts`

- [ ] **Step 1: Write failing test**

Create `packages/debug-web/src/store.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  sessions, upsertSession, removeSession,
  promptRequestsBySession, addPromptRequest,
} from './store.js';

describe('removeSession side-effects', () => {
  beforeEach(() => {
    sessions.value = [];
    promptRequestsBySession.value = {};
  });

  it('clears promptRequestsBySession[id] when removing a session', () => {
    upsertSession({
      id: 's1', name: 'n', agent: 'claude-code', cwd: '/x', pid: 1,
      startedAt: 0, state: 'idle' as any, substate: {} as any,
      lastSummaryId: null,
    });
    addPromptRequest({
      sessionId: 's1', requestId: 'r1', origin: 'permission' as any,
      toolName: 'X', expiresAt: Date.now() + 60_000,
      questions: [],
    });
    expect(promptRequestsBySession.value['s1']).toHaveLength(1);

    removeSession('s1');

    expect(promptRequestsBySession.value['s1']).toBeUndefined();
  });
});
```

(The exact `PendingPromptRequest` shape matters less here than the side-effect contract; cast to satisfy types if needed.)

- [ ] **Step 2: Run test to verify failure**

```bash
pnpm --filter @sesshin/debug-web test src/store.test.ts
```

Expected: failure — `promptRequestsBySession.value['s1']` is still defined.

- [ ] **Step 3: Update `removeSession` to also clear prompt-cards**

In `packages/debug-web/src/store.ts`, locate the `removeSession` function and append the cleanup:

```ts
export function removeSession(id: string): void {
  sessions.value = sessions.value.filter((s) => s.id !== id);
  // NEW: also clear any pending prompt-cards for this session.
  // Prevents stale cards lingering after the agent exits / unregisters.
  if (id in promptRequestsBySession.value) {
    const next = { ...promptRequestsBySession.value };
    delete next[id];
    promptRequestsBySession.value = next;
  }
}
```

- [ ] **Step 4: Run test to verify pass**

```bash
pnpm --filter @sesshin/debug-web test src/store.test.ts
```

Expected: pass.

- [ ] **Step 5: Build**

```bash
pnpm build
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/debug-web/src/store.ts packages/debug-web/src/store.test.ts
git commit -m "fix(debug-web): clear prompt-cards on session.removed

Closes a corner where a session-end racing with subscribe-time replay
could leave a stale prompt-card visible. Formalized as a wire contract
in the design spec.

Part of issue #5."
```

---

### Task 12: Run full suite and final integration build

**Files:** none — verification step.

- [ ] **Step 1: Run all package tests**

```bash
pnpm test
```

Expected: every test in every package passes. No new red.

- [ ] **Step 2: Full typecheck across packages**

```bash
pnpm build
```

Expected: clean build.

- [ ] **Step 3: If anything fails, debug it before proceeding to manual verification**

Common failures:
- A schema test in `shared` failing because Zod rejects an unrecognized field somewhere — verify all `.optional()` markers.
- A `connection.test.ts` test timing out — the WS fixture setup may need ~50ms more before subscribing; tune `delay` / `waitFor` intervals locally.
- A typecheck error in `wire.ts` because an `approvals.open()` call elsewhere in the file was missed — search the file for `approvals.open(` and verify both occurrences pass `origin / questions`.

---

### Task 13: Manual verification on a real claude session

**Files:** none — this is hands-on verification.

- [ ] **Step 1: Build and start the hub against a real claude-code session**

```bash
pnpm build
# In one terminal:
pnpm --filter @sesshin/cli start claude
```

(Or the equivalent invocation per the project's README.)

- [ ] **Step 2: Open debug-web in browser**

Navigate to `http://localhost:9662` (or wherever the WS server's static-served UI is mounted).

- [ ] **Step 3: Trigger a Bash prompt in the claude session**

In the claude session, ask claude to run a command that requires permission (e.g., `git push` or anything not pre-allowed).

- [ ] **Step 4: While the prompt-card is visible in debug-web, refresh the page**

Press F5 / Cmd-R in the browser.

**Expected:** The same prompt-card reappears immediately after reload, with the same options. Answering it lets the agent continue.

**Pre-fix actual:** The page comes back empty; the agent stays blocked until claude's hook timeout fires (~120s).

- [ ] **Step 5: Set a pin while debug-web is connected, verify it appears without reload**

In a separate terminal:

```bash
sesshin pin "deploying"
```

(Or hit the REST endpoint directly: `curl -X POST http://127.0.0.1:9663/api/sessions/<id>/pin -H 'Content-Type: application/json' -d '{"pin":"deploying"}'`)

**Expected:** The debug-web UI updates to show the pin without requiring reload.

- [ ] **Step 6: Verify resolvedBy shows in another connected client**

Open debug-web in two browser windows. Trigger a prompt; answer it from window A. In window B, observe that the prompt-card disappears (existing behavior) — this isn't directly visible without UI work in debug-web to surface `resolvedBy`, but inspect the WS frames in browser devtools to verify the `prompt-request.resolved` payload includes `resolvedBy: "remote-adapter:debug-web"`.

(Actual UX rendering of `resolvedBy` is left to a future debug-web polish task.)

- [ ] **Step 7: If all manual checks pass, the implementation is complete**

Mark issue #5 as ready for PR review.

---

## Self-review (post-write)

Spec coverage:
- ✅ Pending prompt-request replay → Tasks 4 (storage), 8 (replay).
- ✅ SessionInfo carries pin/quiet/gate → Task 1 (schema), Task 5 (registry), Task 8 (delivered via session.list at subscribe).
- ✅ session.config-changed wire message → Task 3 (schema), Task 5 (registry emit), Task 6 (capability gate), Task 9 (listener).
- ✅ resolvedBy on prompt-request.resolved → Task 2 (schema), Task 6 (decided path + plumbing), Task 7 (other 5 paths).
- ✅ 'cancelled-tool-completed' added to reason enum → Task 2.
- ✅ removeSession clears prompt-cards → Task 11.
- ✅ Manual verification of refresh + sticky-config sync → Task 13.

Out-of-scope items deferred to follow-up issues (verified not in any task): hub-restart persistence, hook-handler protocol redesign, lastEventId persistence in debug-web sessionStorage.

Type consistency check passed: `applyConfigChanged` (Task 10), `setPin/setQuietUntil/setSessionGateOverride` (Task 5), `pendingForSession` projection (Task 4) all match the field names declared in the schemas (Task 1, 3).
