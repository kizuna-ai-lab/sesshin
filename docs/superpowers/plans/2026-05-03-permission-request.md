# PermissionRequest Hook + Schema Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real PermissionRequest HTTP-hook approval path, separate from PreToolUse, with clean schema split, three-tier stale cleanup, Codex sanitizer scaffold, and `usesPermissionRequest` propagation through diagnostics.

**Architecture:** New hub route `POST /permission/:sessionId` (Claude HTTP-hook payload, decision-shape JSON response) coexists with the existing command-hook `/hooks` route (PreToolUse-shape). Per-session auto-detection short-circuits the PreToolUse approval gate once a PermissionRequest is observed. Pending requests from either path share one `ApprovalManager`; PostToolUse / PostToolUseFailure / Stop on `/hooks` clear stale entries by exact `(sessionId, tool_use_id)`, by `(sessionId, toolName, sha1(tool_input))` fingerprint fallback, or by singleton-on-Stop. CLI install path stays in temp-file land — `~/.claude/settings.json` is never touched.

**Tech Stack:** TypeScript, Zod (schema validation, discriminated unions), Vitest (runner), pnpm workspace (`@sesshin/shared`, `@sesshin/hub`, `@sesshin/cli`), Node 22.

**Spec:** `docs/superpowers/specs/2026-05-03-permission-request-design.md`

**Branch:** `worktree-permission-request` (worktree at `.claude/worktrees/permission-request`).

**Test commands you'll use repeatedly:**
- Single file: `pnpm --filter @sesshin/<pkg> exec vitest run <path>`
- Whole package: `pnpm --filter @sesshin/<pkg> test`
- Build a package: `pnpm --filter @sesshin/<pkg> build`
- Always rebuild `shared` after changing it before downstream packages compile against it: `pnpm --filter @sesshin/shared build`

---

## File Structure

**New files (8):**
- `packages/shared/src/permission.ts` — discriminated-union response schemas
- `packages/shared/src/tool-fingerprint.ts` — bounded normalize + sha1 fingerprint
- `packages/shared/src/tool-fingerprint.test.ts` — fingerprint stability + bounds
- `packages/hub/src/agents/codex/permission-response.ts` — Codex sanitizer (scaffold)
- `packages/hub/src/agents/codex/permission-response.test.ts`
- `packages/hub/src/rest/permission.ts` — `/permission/:sessionId` route handler (extracted from `server.ts`)
- `packages/hub/src/rest/permission.test.ts`
- `tests/e2e/permission-request.test.ts`

**Modified files (~18):**
- `packages/shared/src/hook-events.ts` — add `PermissionRequest` and `PostToolUseFailure` to enum + map
- `packages/shared/src/index.ts` — export new modules
- `packages/hub/src/approval-manager.ts` — fingerprint field, two indexes, three resolve methods
- `packages/hub/src/approval-manager.test.ts`
- `packages/hub/src/registry/session-registry.ts` — `usesPermissionRequest` field + `markUsesPermissionRequest`
- `packages/hub/src/agents/claude/approval-policy.ts` — short-circuit when registry says session uses PermissionRequest
- `packages/hub/src/agents/claude/approval-policy.test.ts`
- `packages/hub/src/rest/server.ts` — register new route; cleanup branch on `/hooks`; reject `event === 'PermissionRequest'`
- `packages/hub/src/rest/hooks.test.ts`
- `packages/hub/src/wire.ts` — wire `onPermissionRequestApproval`; share ApprovalManager; honor `usesPermissionRequest` in PreToolUse adapter
- `packages/hub/src/agents/claude/tool-handlers/exit-plan-mode.test.ts`
- `packages/hub/src/agents/claude/tool-handlers/ask-user-question.test.ts`
- `packages/cli/src/settings-tempfile.ts` — emit PermissionRequest HTTP entry
- `packages/cli/src/settings-tempfile.test.ts`
- `packages/hub/src/rest/diagnostics.ts` — add `usesPermissionRequest` to per-session snapshot
- `packages/hub/src/rest/diagnostics.test.ts`
- `packages/cli/src/subcommands/status.ts` — extend `DiagSession` + `pr=yes|no` output
- `packages/cli/src/commands-bundle/sesshin-status.md`

**Deviation from spec §5.1:** spec mentions renaming `PendingApproval.tool` → `toolName`. The plan keeps the existing `tool` field name to avoid touching `wire.ts`, WS broadcasts, and unrelated tests. Only `toolInputFingerprint` is added. (Spec note about renaming is vestigial — to be removed in a follow-up doc edit; functionality unchanged.)

---

## Phase A — Shared types & helpers (no dependencies on other phases)

### Task 1: Add `PermissionRequest` and `PostToolUseFailure` to normalized event vocabulary

**Files:**
- Modify: `packages/shared/src/hook-events.ts`
- Modify: `packages/shared/src/hook-events.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `packages/shared/src/hook-events.test.ts` (existing file; append after the existing `it(...)` block):

```ts
import { describe, it, expect } from 'vitest';
import { NormalizedHookEventEnum, ClaudeHookMap, normalizeClaudeEvent } from './hook-events.js';

describe('hook-events — PermissionRequest + PostToolUseFailure', () => {
  it('NormalizedHookEventEnum includes PermissionRequest', () => {
    expect(NormalizedHookEventEnum.options).toContain('PermissionRequest');
  });
  it('NormalizedHookEventEnum includes PostToolUseFailure', () => {
    expect(NormalizedHookEventEnum.options).toContain('PostToolUseFailure');
  });
  it('ClaudeHookMap maps both events identity-wise', () => {
    expect(ClaudeHookMap['PermissionRequest']).toBe('PermissionRequest');
    expect(ClaudeHookMap['PostToolUseFailure']).toBe('PostToolUseFailure');
  });
  it('normalizeClaudeEvent passes both through', () => {
    expect(normalizeClaudeEvent('PermissionRequest')).toBe('PermissionRequest');
    expect(normalizeClaudeEvent('PostToolUseFailure')).toBe('PostToolUseFailure');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
pnpm --filter @sesshin/shared exec vitest run src/hook-events.test.ts
```

Expected: 4 new tests FAIL (enum doesn't include the new values).

- [ ] **Step 3: Add the values**

Edit `packages/shared/src/hook-events.ts`:

```ts
import { z } from 'zod';

export const NormalizedHookEventEnum = z.enum([
  'SessionStart', 'UserPromptSubmit',
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest',
  'Stop', 'StopFailure', 'SessionEnd',
  'agent-internal',
]);
export type NormalizedHookEvent = z.infer<typeof NormalizedHookEventEnum>;

export const ClaudeHookMap: Record<string, NormalizedHookEvent> = {
  SessionStart: 'SessionStart',
  UserPromptSubmit: 'UserPromptSubmit',
  PreToolUse: 'PreToolUse',
  PostToolUse: 'PostToolUse',
  PostToolUseFailure: 'PostToolUseFailure',
  PermissionRequest: 'PermissionRequest',
  Stop: 'Stop',
  StopFailure: 'StopFailure',
  SessionEnd: 'SessionEnd',
};

export function normalizeClaudeEvent(native: string): NormalizedHookEvent {
  const mapped = ClaudeHookMap[native];
  return mapped ?? 'agent-internal';
}
```

- [ ] **Step 4: Verify tests pass**

```
pnpm --filter @sesshin/shared exec vitest run src/hook-events.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Build shared so downstream sees new exports**

```
pnpm --filter @sesshin/shared build
```

Expected: builds without errors.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/hook-events.ts packages/shared/src/hook-events.test.ts packages/shared/dist
git commit -m "shared: add PermissionRequest + PostToolUseFailure to normalized event vocabulary"
```

---

### Task 2: Tool-input fingerprint helper

**Files:**
- Create: `packages/shared/src/tool-fingerprint.ts`
- Create: `packages/shared/src/tool-fingerprint.test.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/shared/src/tool-fingerprint.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { fingerprintToolInput, normalizeToolInput } from './tool-fingerprint.js';

describe('tool-fingerprint', () => {
  it('returns 40-char hex sha1', () => {
    const fp = fingerprintToolInput({ a: 1 });
    expect(fp).toMatch(/^[0-9a-f]{40}$/);
  });
  it('is stable across object key reorder', () => {
    const a = fingerprintToolInput({ x: 1, y: 2, z: 3 });
    const b = fingerprintToolInput({ z: 3, y: 2, x: 1 });
    expect(a).toBe(b);
  });
  it('differs on different values', () => {
    expect(fingerprintToolInput({ a: 1 })).not.toBe(fingerprintToolInput({ a: 2 }));
  });
  it('caps very long strings at 240 chars (with truncation marker)', () => {
    const long = 'x'.repeat(500);
    const norm = normalizeToolInput(long);
    expect(typeof norm).toBe('string');
    expect((norm as string).length).toBe(240);
    expect((norm as string).endsWith('…')).toBe(true);
  });
  it('caps arrays at 16 elements', () => {
    const arr = Array.from({ length: 30 }, (_, i) => i);
    const norm = normalizeToolInput(arr);
    expect(Array.isArray(norm)).toBe(true);
    expect((norm as unknown[]).length).toBe(16);
  });
  it('caps object keys at 32 (sorted)', () => {
    const obj: Record<string, number> = {};
    for (let i = 0; i < 50; i += 1) obj[`k${String(i).padStart(3, '0')}`] = i;
    const norm = normalizeToolInput(obj) as Record<string, unknown>;
    expect(Object.keys(norm).length).toBe(32);
    // sorted keys: first should be k000
    expect(Object.keys(norm)[0]).toBe('k000');
  });
  it('caps depth at 6', () => {
    let nested: unknown = 'leaf';
    for (let i = 0; i < 10; i += 1) nested = { wrap: nested };
    // Should not throw, should not recurse infinitely
    const fp = fingerprintToolInput(nested);
    expect(fp).toMatch(/^[0-9a-f]{40}$/);
  });
  it('handles primitives and null', () => {
    expect(fingerprintToolInput(null)).toMatch(/^[0-9a-f]{40}$/);
    expect(fingerprintToolInput(42)).toMatch(/^[0-9a-f]{40}$/);
    expect(fingerprintToolInput(true)).toMatch(/^[0-9a-f]{40}$/);
  });
  it('handles non-object inputs without crashing', () => {
    expect(fingerprintToolInput(undefined)).toMatch(/^[0-9a-f]{40}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
pnpm --filter @sesshin/shared exec vitest run src/tool-fingerprint.test.ts
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `packages/shared/src/tool-fingerprint.ts`:

```ts
import { createHash } from 'node:crypto';

const STR_MAX = 240;
const ARR_MAX = 16;
const KEY_MAX = 32;
const DEPTH_MAX = 6;

/**
 * Bounded structural normalization for fingerprinting. Caps:
 * - strings to 240 chars (suffix '…' marker on truncation)
 * - arrays to 16 elements
 * - object keys to 32 (sorted lexicographically)
 * - depth to 6 (deeper levels collapse to null)
 *
 * Port of clawd-on-desk's normalizeToolMatchValue. The bounds keep the hash
 * stable on logically-equivalent payloads (object key order, long strings)
 * while preventing pathological inputs from doing unbounded work.
 */
export function normalizeToolInput(value: unknown, depth = 0): unknown {
  if (depth > DEPTH_MAX) return null;
  if (Array.isArray(value)) {
    return value.slice(0, ARR_MAX).map((entry) => normalizeToolInput(entry, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort().slice(0, KEY_MAX);
    for (const key of keys) {
      out[key] = normalizeToolInput((value as Record<string, unknown>)[key], depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') {
    return value.length > STR_MAX ? `${value.slice(0, STR_MAX - 1)}…` : value;
  }
  return value ?? null;
}

/** sha1 hex digest of the JSON-serialized normalized value. Always 40 hex chars. */
export function fingerprintToolInput(input: unknown): string {
  const norm = normalizeToolInput(input);
  return createHash('sha1').update(JSON.stringify(norm)).digest('hex');
}
```

- [ ] **Step 4: Export from shared index**

Edit `packages/shared/src/index.ts` — append:

```ts
export * from './tool-fingerprint.js';
```

- [ ] **Step 5: Verify tests pass**

```
pnpm --filter @sesshin/shared exec vitest run src/tool-fingerprint.test.ts
```

Expected: 9 tests PASS.

- [ ] **Step 6: Build**

```
pnpm --filter @sesshin/shared build
```

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/tool-fingerprint.ts packages/shared/src/tool-fingerprint.test.ts packages/shared/src/index.ts packages/shared/dist
git commit -m "shared: add bounded tool-input fingerprint (sha1)"
```

---

### Task 3: PermissionRequest response schemas (discriminated union)

**Files:**
- Create: `packages/shared/src/permission.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Implement (no test file at the shared level — Zod itself enforces the constraints; route-level tests in Task 11/12 cover wire-level)**

Create `packages/shared/src/permission.ts`:

```ts
import { z } from 'zod';

/**
 * Claude Code's PermissionRequest decision shape. Discriminated on `behavior`:
 * - `allow` may carry `updatedInput` (replaces tool_input on execution)
 * - `deny`  may carry `message` (surfaced to the user / model)
 *
 * The discriminated union forbids `message` on allow and `updatedInput` on
 * deny at the type level — cannot accidentally leak fields cross-shape.
 */
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

/**
 * Full HTTP response body Claude Code expects from a PermissionRequest hook.
 * Distinct from PreToolUse's `permissionDecision` shape (which lives inline
 * in rest/server.ts and uses 'allow'|'deny'|'ask' strings, not objects).
 */
export const PermissionRequestResponse = z.object({
  hookSpecificOutput: z.object({
    hookEventName: z.literal('PermissionRequest'),
    decision: PermissionRequestDecision,
  }),
});
export type PermissionRequestResponse = z.infer<typeof PermissionRequestResponse>;

/**
 * Native Claude PermissionRequest HTTP-hook input body. Parsed in the route
 * handler before envelope construction.
 */
export const PermissionRequestBody = z.object({
  session_id:        z.string(),
  hook_event_name:   z.literal('PermissionRequest'),
  tool_name:         z.string(),
  tool_input:        z.record(z.unknown()),
  tool_use_id:       z.string().optional(),
  cwd:               z.string().optional(),
  transcript_path:   z.string().optional(),
  permission_mode:   z.string().optional(),
  model:             z.string().optional(),
});
export type PermissionRequestBody = z.infer<typeof PermissionRequestBody>;
```

- [ ] **Step 2: Export from shared index**

Edit `packages/shared/src/index.ts` — append:

```ts
export * from './permission.js';
```

- [ ] **Step 3: Build**

```
pnpm --filter @sesshin/shared build
```

Expected: builds without errors.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/permission.ts packages/shared/src/index.ts packages/shared/dist
git commit -m "shared: add PermissionRequest schemas (body, decision, response)"
```

---

## Phase B — Hub bookkeeping (depends on Phase A)

### Task 4: ApprovalManager — fingerprint field on PendingApproval

**Files:**
- Modify: `packages/hub/src/approval-manager.ts`
- Modify: `packages/hub/src/approval-manager.test.ts`

- [ ] **Step 1: Write failing test**

Append to `packages/hub/src/approval-manager.test.ts`:

```ts
describe('ApprovalManager — toolInputFingerprint', () => {
  it('open() populates toolInputFingerprint on the public PendingApproval', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    const { request } = m.open({ sessionId: 's', tool: 'Bash', toolInput: { command: 'ls' } });
    expect(request.toolInputFingerprint).toMatch(/^[0-9a-f]{40}$/);
  });
  it('two open() calls with identical toolInput produce identical fingerprints', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    const a = m.open({ sessionId: 's', tool: 'Bash', toolInput: { command: 'ls' } }).request;
    const b = m.open({ sessionId: 's', tool: 'Bash', toolInput: { command: 'ls' } }).request;
    expect(a.toolInputFingerprint).toBe(b.toolInputFingerprint);
  });
  it('different toolInput → different fingerprint', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    const a = m.open({ sessionId: 's', tool: 'Bash', toolInput: { command: 'ls' } }).request;
    const b = m.open({ sessionId: 's', tool: 'Bash', toolInput: { command: 'pwd' } }).request;
    expect(a.toolInputFingerprint).not.toBe(b.toolInputFingerprint);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
pnpm --filter @sesshin/hub exec vitest run src/approval-manager.test.ts
```

Expected: 3 new tests FAIL (no `toolInputFingerprint` field).

- [ ] **Step 3: Add the field**

Edit `packages/hub/src/approval-manager.ts`:

1. Add import at the top (after `randomUUID`):
   ```ts
   import { fingerprintToolInput } from '@sesshin/shared';
   ```
2. Update `PendingApproval` interface — add `toolInputFingerprint`:
   ```ts
   export interface PendingApproval {
     requestId: string;
     sessionId: string;
     tool: string;
     toolInput: unknown;
     toolInputFingerprint: string;   // NEW
     toolUseId?: string;
     createdAt: number;
     expiresAt: number;
   }
   ```
3. In `open()` body, compute and include `toolInputFingerprint`:
   ```ts
   const toolInputFingerprint = fingerprintToolInput(input.toolInput);
   const request: PendingApproval = {
     requestId, sessionId: input.sessionId,
     tool: input.tool, toolInput: input.toolInput,
     toolInputFingerprint,
     ...(input.toolUseId !== undefined ? { toolUseId: input.toolUseId } : {}),
     createdAt, expiresAt,
   };
   ```
4. In `pendingForSession()` (around line 119), include the field in the projected output:
   ```ts
   out.push({
     requestId: e.requestId, sessionId: e.sessionId,
     tool: e.tool, toolInput: e.toolInput,
     toolInputFingerprint: e.toolInputFingerprint,
     ...(e.toolUseId !== undefined ? { toolUseId: e.toolUseId } : {}),
     createdAt: e.createdAt, expiresAt: e.expiresAt,
   });
   ```

- [ ] **Step 4: Verify tests pass**

```
pnpm --filter @sesshin/hub exec vitest run src/approval-manager.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/approval-manager.ts packages/hub/src/approval-manager.test.ts
git commit -m "hub: ApprovalManager — add toolInputFingerprint to PendingApproval"
```

---

### Task 5: ApprovalManager — `byToolUseId` index + `resolveByToolUseId`

**Files:**
- Modify: `packages/hub/src/approval-manager.ts`
- Modify: `packages/hub/src/approval-manager.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `packages/hub/src/approval-manager.test.ts`:

```ts
describe('ApprovalManager — resolveByToolUseId', () => {
  it('resolves matching entry, returns 1, fulfills decision Promise with the outcome', async () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    const { request, decision } = m.open({
      sessionId: 's', tool: 'Bash', toolInput: { command: 'ls' }, toolUseId: 'tu_1',
    });
    expect(request.toolUseId).toBe('tu_1');
    const n = m.resolveByToolUseId('s', 'tu_1', { decision: 'deny', reason: 'r' });
    expect(n).toBe(1);
    await expect(decision).resolves.toEqual({ decision: 'deny', reason: 'r' });
  });
  it('returns 0 when no entry matches', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    expect(m.resolveByToolUseId('s', 'tu_missing', { decision: 'ask' })).toBe(0);
  });
  it('returns 0 when toolUseId differs from the open() entry', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    m.open({ sessionId: 's', tool: 'Bash', toolInput: {}, toolUseId: 'tu_1' });
    expect(m.resolveByToolUseId('s', 'tu_2', { decision: 'ask' })).toBe(0);
  });
  it('returns 0 when sessionId differs', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    m.open({ sessionId: 's1', tool: 'Bash', toolInput: {}, toolUseId: 'tu_1' });
    expect(m.resolveByToolUseId('s2', 'tu_1', { decision: 'ask' })).toBe(0);
  });
  it('after resolveByToolUseId, the entry is gone from pendingForSession', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    m.open({ sessionId: 's', tool: 'Bash', toolInput: {}, toolUseId: 'tu_1' });
    expect(m.pendingForSession('s')).toHaveLength(1);
    m.resolveByToolUseId('s', 'tu_1', { decision: 'allow' });
    expect(m.pendingForSession('s')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
pnpm --filter @sesshin/hub exec vitest run src/approval-manager.test.ts
```

Expected: 5 FAIL — `resolveByToolUseId` not defined.

- [ ] **Step 3: Implement**

Edit `packages/hub/src/approval-manager.ts`:

1. Add private field at the top of the class (before `pending`):
   ```ts
   private byToolUseId = new Map<string, string>();   // `${sessionId}|${toolUseId}` → requestId
   ```
2. In `open()`, after `this.pending.set(requestId, entry)`, insert:
   ```ts
   if (input.toolUseId !== undefined) {
     this.byToolUseId.set(`${input.sessionId}|${input.toolUseId}`, requestId);
   }
   ```
3. In `decide()`, before `this.pending.delete(requestId)`, clear the index too:
   ```ts
   if (entry.toolUseId !== undefined) {
     this.byToolUseId.delete(`${entry.sessionId}|${entry.toolUseId}`);
   }
   ```
4. In the timeout callback inside `open()` (after `this.pending.delete(requestId)`), clear the index too:
   ```ts
   if (request.toolUseId !== undefined) {
     this.byToolUseId.delete(`${request.sessionId}|${request.toolUseId}`);
   }
   ```
5. In `cancelForSession()` loop, clear the index entry on each cancellation:
   ```ts
   for (const [rid, e] of this.pending) {
     if (e.sessionId !== sessionId) continue;
     clearTimeout(e.timer);
     this.pending.delete(rid);
     if (e.toolUseId !== undefined) {
       this.byToolUseId.delete(`${e.sessionId}|${e.toolUseId}`);
     }
     e.resolve({ decision: 'ask', reason });
     cancelled += 1;
   }
   ```
6. Add the new public method (right after `cancelOnLastClientGone`):
   ```ts
   /**
    * Resolve a pending approval matched by exact `(sessionId, toolUseId)`.
    * Returns 1 iff a pending request was found and resolved, else 0.
    *
    * Used by the stale-cleanup path: when PostToolUse / Stop arrives for a
    * tool whose approval is still pending, we don't want to leave the hook's
    * HTTP connection waiting on a decision that will no longer affect runtime.
    */
   resolveByToolUseId(sessionId: string, toolUseId: string, outcome: ApprovalOutcome): 0 | 1 {
     const requestId = this.byToolUseId.get(`${sessionId}|${toolUseId}`);
     if (!requestId) return 0;
     return this.decide(requestId, outcome) ? 1 : 0;
   }
   ```

- [ ] **Step 4: Verify tests pass**

```
pnpm --filter @sesshin/hub exec vitest run src/approval-manager.test.ts
```

Expected: all PASS (including the older tests — index cleanup must not break them).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/approval-manager.ts packages/hub/src/approval-manager.test.ts
git commit -m "hub: ApprovalManager — byToolUseId index + resolveByToolUseId"
```

---

### Task 6: ApprovalManager — `byFingerprint` index + `resolveByFingerprint`

**Files:**
- Modify: `packages/hub/src/approval-manager.ts`
- Modify: `packages/hub/src/approval-manager.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `packages/hub/src/approval-manager.test.ts`:

```ts
describe('ApprovalManager — resolveByFingerprint', () => {
  it('resolves single match without toolUseId, returns 1', async () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    const { request, decision } = m.open({
      sessionId: 's', tool: 'Bash', toolInput: { command: 'ls' },
    });
    const fp = request.toolInputFingerprint;
    expect(m.resolveByFingerprint('s', 'Bash', fp, { decision: 'deny', reason: 'x' })).toBe(1);
    await expect(decision).resolves.toEqual({ decision: 'deny', reason: 'x' });
  });
  it('returns 0 when set has 2+ entries with same fingerprint (ambiguous)', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    const a = m.open({ sessionId: 's', tool: 'Bash', toolInput: { command: 'ls' } }).request;
    m.open({ sessionId: 's', tool: 'Bash', toolInput: { command: 'ls' } });
    expect(m.resolveByFingerprint('s', 'Bash', a.toolInputFingerprint, { decision: 'ask' })).toBe(0);
  });
  it('returns 0 when matching entry has toolUseId (canonical match should have caught it)', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    const { request } = m.open({
      sessionId: 's', tool: 'Bash', toolInput: { command: 'ls' }, toolUseId: 'tu_1',
    });
    expect(m.resolveByFingerprint('s', 'Bash', request.toolInputFingerprint, { decision: 'ask' })).toBe(0);
  });
  it('returns 0 when no fingerprint match', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    expect(m.resolveByFingerprint('s', 'Bash', 'a'.repeat(40), { decision: 'ask' })).toBe(0);
  });
  it('returns 0 when toolName differs', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    const { request } = m.open({ sessionId: 's', tool: 'Bash', toolInput: { command: 'ls' } });
    expect(m.resolveByFingerprint('s', 'Edit', request.toolInputFingerprint, { decision: 'ask' })).toBe(0);
  });
  it('returns 0 when sessionId differs', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    const { request } = m.open({ sessionId: 's1', tool: 'Bash', toolInput: { command: 'ls' } });
    expect(m.resolveByFingerprint('s2', 'Bash', request.toolInputFingerprint, { decision: 'ask' })).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
pnpm --filter @sesshin/hub exec vitest run src/approval-manager.test.ts
```

Expected: 6 FAIL.

- [ ] **Step 3: Implement**

Edit `packages/hub/src/approval-manager.ts`:

1. Add private field at the top of the class:
   ```ts
   private byFingerprint = new Map<string, Set<string>>();   // `${sid}|${tool}|${fp}` → Set<requestId>
   ```
2. Helper at the bottom of the class (private):
   ```ts
   private fpKey(sessionId: string, tool: string, fp: string): string {
     return `${sessionId}|${tool}|${fp}`;
   }
   ```
3. In `open()`, after the `byToolUseId` insertion, add:
   ```ts
   const fpk = this.fpKey(input.sessionId, input.tool, toolInputFingerprint);
   const set = this.byFingerprint.get(fpk) ?? new Set<string>();
   set.add(requestId);
   this.byFingerprint.set(fpk, set);
   ```
4. Extract the index-cleanup logic into a helper (call from `decide()`, the timeout callback, `cancelForSession()`):
   ```ts
   private cleanupIndexes(entry: Entry): void {
     if (entry.toolUseId !== undefined) {
       this.byToolUseId.delete(`${entry.sessionId}|${entry.toolUseId}`);
     }
     const fpk = this.fpKey(entry.sessionId, entry.tool, entry.toolInputFingerprint);
     const set = this.byFingerprint.get(fpk);
     if (set) {
       set.delete(entry.requestId);
       if (set.size === 0) this.byFingerprint.delete(fpk);
     }
   }
   ```
   And replace the per-call inline cleanups in `decide()`, the timeout callback, and `cancelForSession()` with `this.cleanupIndexes(entry)`. (Note: in the timeout callback, you have access to `request: PendingApproval`, not `entry: Entry`; pass `entry` instead — capture the entry from the line where `this.pending.set(requestId, entry)` is called.)
5. Add the public method right after `resolveByToolUseId`:
   ```ts
   /**
    * Resolve a pending approval matched by `(sessionId, toolName, fingerprint)`.
    * Only resolves when:
    *   - the fingerprint set has exactly one entry, AND
    *   - that entry has no `toolUseId` set (canonical match should have caught it)
    *
    * Returns 1 if resolved, else 0.
    */
   resolveByFingerprint(
     sessionId: string, toolName: string, fingerprint: string, outcome: ApprovalOutcome,
   ): 0 | 1 {
     const set = this.byFingerprint.get(this.fpKey(sessionId, toolName, fingerprint));
     if (!set || set.size !== 1) return 0;
     const requestId = set.values().next().value as string;
     const entry = this.pending.get(requestId);
     if (!entry) return 0;
     if (entry.toolUseId !== undefined) return 0;
     return this.decide(requestId, outcome) ? 1 : 0;
   }
   ```

- [ ] **Step 4: Verify all tests pass (old + new)**

```
pnpm --filter @sesshin/hub exec vitest run src/approval-manager.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/approval-manager.ts packages/hub/src/approval-manager.test.ts
git commit -m "hub: ApprovalManager — byFingerprint index + resolveByFingerprint"
```

---

### Task 7: ApprovalManager — `resolveSingletonForSession`

**Files:**
- Modify: `packages/hub/src/approval-manager.ts`
- Modify: `packages/hub/src/approval-manager.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `packages/hub/src/approval-manager.test.ts`:

```ts
describe('ApprovalManager — resolveSingletonForSession', () => {
  it('resolves the only pending entry for a session, returns 1', async () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    const { decision } = m.open({ sessionId: 's', tool: 'Bash', toolInput: {} });
    expect(m.resolveSingletonForSession('s', { decision: 'deny', reason: 'r' })).toBe(1);
    await expect(decision).resolves.toEqual({ decision: 'deny', reason: 'r' });
  });
  it('returns 0 when 0 pending entries', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    expect(m.resolveSingletonForSession('s', { decision: 'ask' })).toBe(0);
  });
  it('returns 0 when 2+ pending entries (ambiguous)', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    m.open({ sessionId: 's', tool: 'Bash', toolInput: {} });
    m.open({ sessionId: 's', tool: 'Edit', toolInput: {} });
    expect(m.resolveSingletonForSession('s', { decision: 'ask' })).toBe(0);
  });
  it('only counts entries for the given session', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    m.open({ sessionId: 's1', tool: 'Bash', toolInput: {} });
    m.open({ sessionId: 's2', tool: 'Bash', toolInput: {} });
    // Two pending overall, but each session has exactly one
    expect(m.resolveSingletonForSession('s1', { decision: 'allow' })).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
pnpm --filter @sesshin/hub exec vitest run src/approval-manager.test.ts
```

Expected: 4 FAIL.

- [ ] **Step 3: Implement**

Edit `packages/hub/src/approval-manager.ts` — add right after `resolveByFingerprint`:

```ts
/**
 * Resolve the unique pending approval for a session, if there is exactly one.
 * Returns 1 if resolved, else 0.
 *
 * Used as last-resort cleanup on `Stop` events when no toolUseId / fingerprint
 * match is available — it's safe because Claude only emits one Stop per turn.
 */
resolveSingletonForSession(sessionId: string, outcome: ApprovalOutcome): 0 | 1 {
  let candidate: string | null = null;
  for (const [rid, e] of this.pending) {
    if (e.sessionId !== sessionId) continue;
    if (candidate !== null) return 0;   // 2+ entries → ambiguous
    candidate = rid;
  }
  if (candidate === null) return 0;
  return this.decide(candidate, outcome) ? 1 : 0;
}
```

- [ ] **Step 4: Verify tests pass**

```
pnpm --filter @sesshin/hub exec vitest run src/approval-manager.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/approval-manager.ts packages/hub/src/approval-manager.test.ts
git commit -m "hub: ApprovalManager — resolveSingletonForSession (Stop fallback)"
```

---

### Task 8: SessionRegistry — `usesPermissionRequest` field + `markUsesPermissionRequest`

**Files:**
- Modify: `packages/hub/src/registry/session-registry.ts`
- Create or extend: `packages/hub/src/registry/session-registry.test.ts` (create if missing)

- [ ] **Step 1: Write failing tests**

Check if a test file exists; if not create `packages/hub/src/registry/session-registry.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { SessionRegistry } from './session-registry.js';

describe('SessionRegistry — usesPermissionRequest', () => {
  it('newly-registered session has usesPermissionRequest=false', () => {
    const r = new SessionRegistry();
    r.register({ id: 's', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    expect(r.get('s')!.usesPermissionRequest).toBe(false);
  });
  it('markUsesPermissionRequest sets the flag and returns true on first call', () => {
    const r = new SessionRegistry();
    r.register({ id: 's', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    expect(r.markUsesPermissionRequest('s')).toBe(true);
    expect(r.get('s')!.usesPermissionRequest).toBe(true);
  });
  it('markUsesPermissionRequest returns false when already set (idempotent)', () => {
    const r = new SessionRegistry();
    r.register({ id: 's', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    r.markUsesPermissionRequest('s');
    expect(r.markUsesPermissionRequest('s')).toBe(false);
  });
  it('markUsesPermissionRequest returns false when session not registered', () => {
    const r = new SessionRegistry();
    expect(r.markUsesPermissionRequest('missing')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
pnpm --filter @sesshin/hub exec vitest run src/registry/session-registry.test.ts
```

Expected: FAIL — `usesPermissionRequest` doesn't exist.

- [ ] **Step 3: Implement**

Edit `packages/hub/src/registry/session-registry.ts`:

1. In `SessionRecord` interface, add:
   ```ts
   usesPermissionRequest: boolean;
   ```
2. In `register()`, set the default to `false`:
   ```ts
   const rec: SessionRecord = {
     // … existing fields …
     usesPermissionRequest: false,
   };
   ```
3. Add a method right after the existing `setQuietUntil` / similar single-flag mutators (search for the methods like `setSessionGateOverride`, `setPin` to find the right neighborhood):
   ```ts
   /**
    * Mark a session as using PermissionRequest as its real approval gate.
    * Once set the flag is sticky for the session lifetime.
    * Returns true iff this call changed the flag from false→true.
    */
   markUsesPermissionRequest(sessionId: string): boolean {
     const s = this.sessions.get(sessionId);
     if (!s) return false;
     if (s.usesPermissionRequest) return false;
     s.usesPermissionRequest = true;
     return true;
   }
   ```

- [ ] **Step 4: Verify tests pass**

```
pnpm --filter @sesshin/hub exec vitest run src/registry/session-registry.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/registry/session-registry.ts packages/hub/src/registry/session-registry.test.ts
git commit -m "hub: SessionRegistry — usesPermissionRequest flag + markUsesPermissionRequest"
```

---

### Task 9: approval-policy — short-circuit when session uses PermissionRequest

**Files:**
- Modify: `packages/hub/src/agents/claude/approval-policy.ts`
- Modify: `packages/hub/src/agents/claude/approval-policy.test.ts`

- [ ] **Step 1: Write failing test**

Append to `packages/hub/src/agents/claude/approval-policy.test.ts` (use the existing test's helpers / shape):

```ts
describe('shouldGatePreToolUse — usesPermissionRequest short-circuit', () => {
  it('returns false when usesPermissionRequest=true regardless of mode/tool/policy', () => {
    expect(shouldGatePreToolUse(
      { tool_name: 'Bash', tool_input: { command: 'ls' }, permission_mode: 'default' },
      'default',
      'always',
      { sessionAllowList: [], claudeAllowRules: [] },
      true,           // hasSubscribedClient
      true,           // usesPermissionRequest (NEW)
    )).toBe(false);
  });
  it('returns false even with policy=always and gated tool', () => {
    expect(shouldGatePreToolUse(
      { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } },
      'default',
      'always',
      { sessionAllowList: [], claudeAllowRules: [] },
      true,
      true,
    )).toBe(false);
  });
  it('default usesPermissionRequest=false preserves existing behavior', () => {
    // Existing call signatures with no 6th arg should continue to work
    expect(shouldGatePreToolUse(
      { tool_name: 'Bash', tool_input: { command: 'ls' } },
      'default',
      'auto',
      { sessionAllowList: [], claudeAllowRules: [] },
      true,
    )).toBe(true);   // no short-circuit, normal gating logic applies
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
pnpm --filter @sesshin/hub exec vitest run src/agents/claude/approval-policy.test.ts
```

Expected: TS error or test FAIL — `shouldGatePreToolUse` doesn't accept the new param.

- [ ] **Step 3: Add the parameter and short-circuit**

Edit `packages/hub/src/agents/claude/approval-policy.ts` — extend the signature and add the check at the top of the function body:

```ts
export function shouldGatePreToolUse(
  raw: Record<string, unknown>,
  knownMode: PermissionMode | undefined,
  policy: ApprovalGatePolicy,
  allow: AllowContext = { sessionAllowList: [], claudeAllowRules: [] },
  hasSubscribedClient: boolean = true,
  /**
   * When true, the session has been observed using the PermissionRequest
   * HTTP hook as its real approval gate. PreToolUse should pass through
   * (return false) so we don't double-gate.
   */
  usesPermissionRequest: boolean = false,
): boolean {
  if (usesPermissionRequest)  return false;
  if (policy === 'disabled')  return false;
  if (policy === 'always')    return true;
  // … existing 'auto' branch unchanged …
}
```

- [ ] **Step 4: Verify tests pass**

```
pnpm --filter @sesshin/hub exec vitest run src/agents/claude/approval-policy.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/agents/claude/approval-policy.ts packages/hub/src/agents/claude/approval-policy.test.ts
git commit -m "hub: approval-policy — short-circuit when usesPermissionRequest=true"
```

---

## Phase C — Codex sanitizer (independent of B; doable in parallel)

### Task 10: Codex sanitizer scaffold

**Files:**
- Create: `packages/hub/src/agents/codex/permission-response.ts`
- Create: `packages/hub/src/agents/codex/permission-response.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/hub/src/agents/codex/permission-response.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  sanitizeCodexPermissionDecision,
  buildCodexPermissionResponseBody,
} from './permission-response.js';

describe('sanitizeCodexPermissionDecision', () => {
  it('allow strips updatedInput', () => {
    expect(sanitizeCodexPermissionDecision({
      behavior: 'allow', updatedInput: { command: 'ls' },
    })).toEqual({ behavior: 'allow' });
  });
  it('allow with no fields stays {behavior:"allow"}', () => {
    expect(sanitizeCodexPermissionDecision({ behavior: 'allow' }))
      .toEqual({ behavior: 'allow' });
  });
  it('deny preserves message', () => {
    expect(sanitizeCodexPermissionDecision({ behavior: 'deny', message: 'no' }))
      .toEqual({ behavior: 'deny', message: 'no' });
  });
  it('deny with no message stays {behavior:"deny"}', () => {
    expect(sanitizeCodexPermissionDecision({ behavior: 'deny' }))
      .toEqual({ behavior: 'deny' });
  });
});

describe('buildCodexPermissionResponseBody', () => {
  it('produces full hookSpecificOutput envelope for allow', () => {
    const body = buildCodexPermissionResponseBody({ behavior: 'allow', updatedInput: { x: 1 } });
    expect(JSON.parse(body)).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
  });
  it('produces full envelope for deny with message', () => {
    const body = buildCodexPermissionResponseBody({ behavior: 'deny', message: 'no' });
    expect(JSON.parse(body)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'no' },
      },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
pnpm --filter @sesshin/hub exec vitest run src/agents/codex/permission-response.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

Create `packages/hub/src/agents/codex/permission-response.ts`:

```ts
import type { PermissionRequestDecision } from '@sesshin/shared';

/**
 * Codex-safe variant of a PermissionRequest decision.
 *
 * Codex's PermissionRequest hook today fails-closed if the response carries
 * `updatedInput`, `updatedPermissions`, or `interrupt`. Codex also doesn't
 * accept `message` on `allow` responses. This sanitizer strips those fields
 * before serialization.
 *
 * Scaffold only — not yet wired into a real Codex agent path. Lives behind a
 * future `agent === 'codex'` branch.
 */
export function sanitizeCodexPermissionDecision(
  d: PermissionRequestDecision,
): PermissionRequestDecision {
  if (d.behavior === 'allow') return { behavior: 'allow' };
  return d.message ? { behavior: 'deny', message: d.message } : { behavior: 'deny' };
}

/**
 * Build the full HTTP response body Codex's PermissionRequest hook expects.
 * Always returns valid JSON — the shape mirrors Claude Code's response, but
 * with Codex-safe sanitizing applied to the decision.
 */
export function buildCodexPermissionResponseBody(d: PermissionRequestDecision): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: sanitizeCodexPermissionDecision(d),
    },
  });
}
```

- [ ] **Step 4: Verify tests pass**

```
pnpm --filter @sesshin/hub exec vitest run src/agents/codex/permission-response.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
mkdir -p packages/hub/src/agents/codex
git add packages/hub/src/agents/codex/permission-response.ts packages/hub/src/agents/codex/permission-response.test.ts
git commit -m "hub: Codex permission-response sanitizer (scaffold)"
```

---

## Phase D — REST routes (depends on B)

### Task 11: `/permission/:sessionId` route — happy path

**Files:**
- Create: `packages/hub/src/rest/permission.ts`
- Create: `packages/hub/src/rest/permission.test.ts`
- Modify: `packages/hub/src/rest/server.ts`

- [ ] **Step 1: Write failing test**

Create `packages/hub/src/rest/permission.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRestServer, type RestServer } from './server.js';
import { SessionRegistry } from '../registry/session-registry.js';
import { ApprovalManager } from '../approval-manager.js';

let svr: RestServer; let port: number;
let registry: SessionRegistry;
let approvals: ApprovalManager;

beforeEach(async () => {
  registry = new SessionRegistry();
  approvals = new ApprovalManager({ defaultTimeoutMs: 60_000 });
  registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
});
afterEach(async () => { await svr?.close(); });

const PERM_BODY = (overrides: Record<string, unknown> = {}): unknown => ({
  session_id: 'claude-uuid', hook_event_name: 'PermissionRequest',
  tool_name: 'Bash', tool_input: { command: 'ls' },
  tool_use_id: 'tu_1', ...overrides,
});

describe('POST /permission/:sessionId — happy paths', () => {
  it('returns the allow decision shape from onPermissionRequestApproval', async () => {
    svr = createRestServer({
      registry, approvals,
      onPermissionRequestApproval: async () => ({ behavior: 'allow', updatedInput: { x: 1 } }),
    });
    await svr.listen(0, '127.0.0.1');
    port = svr.address().port;
    const r = await fetch(`http://127.0.0.1:${port}/permission/s1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(PERM_BODY()),
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedInput: { x: 1 } },
      },
    });
  });
  it('returns the deny decision shape with message', async () => {
    svr = createRestServer({
      registry, approvals,
      onPermissionRequestApproval: async () => ({ behavior: 'deny', message: 'nope' }),
    });
    await svr.listen(0, '127.0.0.1');
    port = svr.address().port;
    const r = await fetch(`http://127.0.0.1:${port}/permission/s1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(PERM_BODY()),
    });
    const j = await r.json();
    expect(j.hookSpecificOutput.decision).toEqual({ behavior: 'deny', message: 'nope' });
  });
  it('returns 204 (passthrough) when callback returns null', async () => {
    svr = createRestServer({
      registry, approvals,
      onPermissionRequestApproval: async () => null,
    });
    await svr.listen(0, '127.0.0.1');
    port = svr.address().port;
    const r = await fetch(`http://127.0.0.1:${port}/permission/s1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(PERM_BODY()),
    });
    expect(r.status).toBe(204);
  });
  it('emits onHookEvent with envelope event=PermissionRequest before dispatch', async () => {
    const onHookEvent = vi.fn();
    svr = createRestServer({
      registry, approvals,
      onHookEvent,
      onPermissionRequestApproval: async () => null,
    });
    await svr.listen(0, '127.0.0.1');
    port = svr.address().port;
    await fetch(`http://127.0.0.1:${port}/permission/s1`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(PERM_BODY()),
    });
    expect(onHookEvent).toHaveBeenCalledTimes(1);
    const env = onHookEvent.mock.calls[0]![0];
    expect(env.event).toBe('PermissionRequest');
    expect(env.sessionId).toBe('s1');
    expect(env.agent).toBe('claude-code');
    expect(env.raw['session_id']).toBe('claude-uuid');   // Claude's native id preserved in raw
  });
  it('calls registry.markUsesPermissionRequest before dispatch (sticky opt-in)', async () => {
    svr = createRestServer({
      registry, approvals,
      onPermissionRequestApproval: async () => null,
    });
    await svr.listen(0, '127.0.0.1');
    port = svr.address().port;
    expect(registry.get('s1')!.usesPermissionRequest).toBe(false);
    await fetch(`http://127.0.0.1:${port}/permission/s1`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(PERM_BODY()),
    });
    expect(registry.get('s1')!.usesPermissionRequest).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
pnpm --filter @sesshin/hub exec vitest run src/rest/permission.test.ts
```

Expected: FAIL — route 404.

- [ ] **Step 3: Implement the route handler**

Create `packages/hub/src/rest/permission.ts`:

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PermissionRequestBody } from '@sesshin/shared';
import type { RestServerDeps } from './server.js';

const MAX_BODY_BYTES = 524_288;       // 512 KB

export async function handlePermissionRoute(
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
  deps: RestServerDeps,
): Promise<void> {
  // Read body with size cap.
  const chunks: Buffer[] = [];
  let total = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    if (tooLarge) continue;
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) { tooLarge = true; continue; }
    chunks.push(chunk as Buffer);
  }
  if (tooLarge) {
    sendDecision(res, { behavior: 'deny', message: 'Permission request too large' });
    return;
  }

  // Session must be registered.
  if (!deps.registry.get(sessionId)) {
    sendDecision(res, { behavior: 'deny', message: 'sesshin: session not registered' });
    return;
  }

  // Parse + validate.
  let raw: unknown;
  try { raw = JSON.parse(Buffer.concat(chunks).toString('utf-8')); }
  catch { res.writeHead(400).end('bad json'); return; }
  const parsed = PermissionRequestBody.safeParse(raw);
  if (!parsed.success) { res.writeHead(400).end(); return; }

  // Sticky opt-in flag — fires before dispatch so the next PreToolUse on
  // this session short-circuits even if dispatch throws.
  deps.registry.markUsesPermissionRequest(sessionId);

  // Build normalized envelope; emit onto the bus.
  const envelope = {
    agent: 'claude-code' as const,
    sessionId,
    ts: Date.now(),
    event: 'PermissionRequest' as const,
    raw: parsed.data as unknown as Record<string, unknown>,
  };
  deps.onHookEvent?.(envelope);

  // Dispatch — null means passthrough (204), otherwise emit the decision shape.
  if (!deps.onPermissionRequestApproval) {
    res.writeHead(204).end();
    return;
  }

  let decision: { behavior: 'allow'|'deny'; updatedInput?: Record<string, unknown>; message?: string } | null;
  try {
    decision = await deps.onPermissionRequestApproval(envelope);
  } catch {
    // Throw → fall through to Claude TUI rather than fail-closed.
    res.writeHead(204).end();
    return;
  }
  if (decision === null) { res.writeHead(204).end(); return; }
  sendDecision(res, decision);
}

function sendDecision(
  res: ServerResponse,
  decision: { behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown>; message?: string },
): void {
  // Build the response with explicit per-behavior shape — keeps types honest.
  const body = decision.behavior === 'allow'
    ? {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest' as const,
          decision: {
            behavior: 'allow' as const,
            ...(decision.updatedInput !== undefined ? { updatedInput: decision.updatedInput } : {}),
          },
        },
      }
    : {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest' as const,
          decision: {
            behavior: 'deny' as const,
            ...(decision.message !== undefined ? { message: decision.message } : {}),
          },
        },
      };
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}
```

- [ ] **Step 4: Wire the route into `server.ts`**

Edit `packages/hub/src/rest/server.ts`:

1. Add import at top:
   ```ts
   import { handlePermissionRoute } from './permission.js';
   ```
2. Extend `RestServerDeps` interface — add field after `onPreToolUseApproval`:
   ```ts
   onPermissionRequestApproval?: (envelope: {
     agent: string; sessionId: string; ts: number; event: string;
     raw: Record<string, unknown>;
   }) => Promise<{
     behavior: 'allow' | 'deny';
     updatedInput?: Record<string, unknown>;
     message?: string;
   } | null>;
   ```
3. In `route()`, add a match before the catch-all 404 (place it near the other regex-based routes):
   ```ts
   const pm2 = url.pathname.match(/^\/permission\/([^/]+)$/);
   if (pm2) {
     const sid = pm2[1]!;
     if (method !== 'POST') return void res.writeHead(405).end();
     return handlePermissionRoute(req, res, sid, deps);
   }
   ```

- [ ] **Step 5: Verify tests pass**

```
pnpm --filter @sesshin/hub exec vitest run src/rest/permission.test.ts
```

Expected: all 5 PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/rest/permission.ts packages/hub/src/rest/permission.test.ts packages/hub/src/rest/server.ts
git commit -m "hub: POST /permission/:sessionId route — happy paths + opt-in marking"
```

---

### Task 12: `/permission/:sessionId` — failure modes (body cap, missing session, malformed, throw)

**Files:**
- Modify: `packages/hub/src/rest/permission.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `packages/hub/src/rest/permission.test.ts`:

```ts
describe('POST /permission/:sessionId — failure modes', () => {
  it('body > 512 KB → 200 + deny "too large"', async () => {
    svr = createRestServer({
      registry, approvals,
      onPermissionRequestApproval: async () => ({ behavior: 'allow' }),
    });
    await svr.listen(0, '127.0.0.1');
    port = svr.address().port;
    const huge = { ...PERM_BODY(), tool_input: { command: 'x'.repeat(600_000) } };
    const r = await fetch(`http://127.0.0.1:${port}/permission/s1`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(huge),
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.hookSpecificOutput.decision).toEqual({
      behavior: 'deny', message: 'Permission request too large',
    });
  });
  it('unregistered :sessionId → 200 + deny "session not registered"', async () => {
    svr = createRestServer({
      registry, approvals,
      onPermissionRequestApproval: async () => ({ behavior: 'allow' }),
    });
    await svr.listen(0, '127.0.0.1');
    port = svr.address().port;
    const r = await fetch(`http://127.0.0.1:${port}/permission/missing`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(PERM_BODY()),
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.hookSpecificOutput.decision).toEqual({
      behavior: 'deny', message: 'sesshin: session not registered',
    });
  });
  it('malformed JSON → 400', async () => {
    svr = createRestServer({ registry, approvals });
    await svr.listen(0, '127.0.0.1');
    port = svr.address().port;
    const r = await fetch(`http://127.0.0.1:${port}/permission/s1`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: '{ this is not json',
    });
    expect(r.status).toBe(400);
  });
  it('Zod fail (missing tool_name) → 400', async () => {
    svr = createRestServer({ registry, approvals });
    await svr.listen(0, '127.0.0.1');
    port = svr.address().port;
    const bad = { session_id: 'x', hook_event_name: 'PermissionRequest', tool_input: {} };
    const r = await fetch(`http://127.0.0.1:${port}/permission/s1`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bad),
    });
    expect(r.status).toBe(400);
  });
  it('callback throws → 204 passthrough (state event still emitted)', async () => {
    const onHookEvent = vi.fn();
    svr = createRestServer({
      registry, approvals,
      onHookEvent,
      onPermissionRequestApproval: async () => { throw new Error('boom'); },
    });
    await svr.listen(0, '127.0.0.1');
    port = svr.address().port;
    const r = await fetch(`http://127.0.0.1:${port}/permission/s1`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(PERM_BODY()),
    });
    expect(r.status).toBe(204);
    expect(onHookEvent).toHaveBeenCalledTimes(1);   // bus event before throw
  });
  it('GET /permission/:sessionId → 405', async () => {
    svr = createRestServer({ registry, approvals });
    await svr.listen(0, '127.0.0.1');
    port = svr.address().port;
    const r = await fetch(`http://127.0.0.1:${port}/permission/s1`);
    expect(r.status).toBe(405);
  });
  it('POST /permission (no segment) → 404', async () => {
    svr = createRestServer({ registry, approvals });
    await svr.listen(0, '127.0.0.1');
    port = svr.address().port;
    const r = await fetch(`http://127.0.0.1:${port}/permission`, { method: 'POST' });
    expect(r.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests**

```
pnpm --filter @sesshin/hub exec vitest run src/rest/permission.test.ts
```

Expected: all PASS — implementation in Task 11 already covers these paths.

- [ ] **Step 3: If any fail, fix in `permission.ts`** — common gotcha is the body-cap test depending on the order of checks (size-cap fires before session lookup). Verify the implementation matches the route's order: read-with-cap → tooLarge deny → session lookup → JSON parse → Zod → opt-in → bus → dispatch.

- [ ] **Step 4: Commit**

```bash
git add packages/hub/src/rest/permission.test.ts packages/hub/src/rest/permission.ts
git commit -m "hub: POST /permission/:sessionId — failure-mode tests + adjustments"
```

---

### Task 13: `/hooks` — reject `event === 'PermissionRequest'` (schema split enforcement)

**Files:**
- Modify: `packages/hub/src/rest/server.ts`
- Modify: `packages/hub/src/rest/hooks.test.ts`

- [ ] **Step 1: Write failing test**

Append to `packages/hub/src/rest/hooks.test.ts`:

```ts
describe('/hooks — schema split', () => {
  it('rejects envelope with event=PermissionRequest with 400', async () => {
    const body = {
      agent: 'claude-code', sessionId: 's1', ts: Date.now(),
      event: 'PermissionRequest', raw: {},
    };
    const r = await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(r.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test**

```
pnpm --filter @sesshin/hub exec vitest run src/rest/hooks.test.ts
```

Expected: FAIL — currently 204'd as a generic event.

- [ ] **Step 3: Implement**

Edit `packages/hub/src/rest/server.ts` — in `ingestHook`, immediately after `if (!parsed.success) return …;`:

```ts
if (parsed.data.event === 'PermissionRequest') {
  return void res.writeHead(400, { 'content-type': 'application/json' })
    .end(JSON.stringify({ error: 'PermissionRequest must be POSTed to /permission/:sessionId, not /hooks' }));
}
```

- [ ] **Step 4: Verify tests pass**

```
pnpm --filter @sesshin/hub exec vitest run src/rest/hooks.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/rest/server.ts packages/hub/src/rest/hooks.test.ts
git commit -m "hub: /hooks rejects event=PermissionRequest (route to /permission instead)"
```

---

### Task 14: `/hooks` — stale cleanup branch on PostToolUse / PostToolUseFailure / Stop

**Files:**
- Modify: `packages/hub/src/rest/server.ts`
- Modify: `packages/hub/src/rest/hooks.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `packages/hub/src/rest/hooks.test.ts`:

```ts
describe('/hooks — stale cleanup', () => {
  let approvals: ApprovalManager;
  beforeEach(async () => {
    // Re-build the server with an approvals dep.
    await svr.close();
    approvals = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    svr = createRestServer({ registry, approvals });
    await svr.listen(0, '127.0.0.1');
    port = svr.address().port;
  });

  const post = (event: string, raw: Record<string, unknown>): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: 'claude-code', sessionId: 's1', ts: Date.now(), event, raw,
      }),
    });

  it('PostToolUse with matching tool_use_id resolves pending approval', async () => {
    const { decision } = approvals.open({
      sessionId: 's1', tool: 'Bash', toolInput: { command: 'ls' }, toolUseId: 'tu_1',
    });
    const r = await post('PostToolUse', {
      nativeEvent: 'PostToolUse', tool_name: 'Bash',
      tool_input: { command: 'ls' }, tool_use_id: 'tu_1',
    });
    expect(r.status).toBe(204);
    await expect(decision).resolves.toMatchObject({ decision: 'deny' });
    expect(approvals.pendingForSession('s1')).toHaveLength(0);
  });
  it('PostToolUse without tool_use_id but matching fingerprint resolves it', async () => {
    const { decision } = approvals.open({
      sessionId: 's1', tool: 'Bash', toolInput: { command: 'ls' },
      // no toolUseId
    });
    const r = await post('PostToolUse', {
      nativeEvent: 'PostToolUse', tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    expect(r.status).toBe(204);
    await expect(decision).resolves.toMatchObject({ decision: 'deny' });
  });
  it('PostToolUseFailure cleans up the same way (uses normalized event)', async () => {
    const { decision } = approvals.open({
      sessionId: 's1', tool: 'Bash', toolInput: {}, toolUseId: 'tu_2',
    });
    await post('PostToolUseFailure', {
      nativeEvent: 'PostToolUseFailure', tool_name: 'Bash',
      tool_input: {}, tool_use_id: 'tu_2',
    });
    await expect(decision).resolves.toMatchObject({ decision: 'deny' });
  });
  it('Stop with no toolUseId/fingerprint match falls back to singleton', async () => {
    const { decision } = approvals.open({
      sessionId: 's1', tool: 'Bash', toolInput: { command: 'ls' },
    });
    await post('Stop', { nativeEvent: 'Stop' });
    await expect(decision).resolves.toMatchObject({ decision: 'deny' });
  });
  it('Stop does NOT singleton-resolve when 2+ pending entries', async () => {
    approvals.open({ sessionId: 's1', tool: 'Bash', toolInput: { command: 'ls' } });
    approvals.open({ sessionId: 's1', tool: 'Edit', toolInput: { file: 'x' } });
    await post('Stop', { nativeEvent: 'Stop' });
    expect(approvals.pendingForSession('s1')).toHaveLength(2);   // both still pending
  });
  it('PostToolUse without tool_use_id and 2 same-fingerprint entries → no cleanup', async () => {
    approvals.open({ sessionId: 's1', tool: 'Bash', toolInput: { command: 'ls' } });
    approvals.open({ sessionId: 's1', tool: 'Bash', toolInput: { command: 'ls' } });
    await post('PostToolUse', {
      nativeEvent: 'PostToolUse', tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    expect(approvals.pendingForSession('s1')).toHaveLength(2);
  });
  it('PostToolUse on PreToolUse (irrelevant event) does nothing', async () => {
    approvals.open({ sessionId: 's1', tool: 'Bash', toolInput: {}, toolUseId: 'tu_x' });
    await post('UserPromptSubmit', { nativeEvent: 'UserPromptSubmit' });
    expect(approvals.pendingForSession('s1')).toHaveLength(1);
  });
});
```

Note: `hooks.test.ts` may need an additional import at the top:

```ts
import { ApprovalManager } from '../approval-manager.js';
```

- [ ] **Step 2: Run tests**

```
pnpm --filter @sesshin/hub exec vitest run src/rest/hooks.test.ts
```

Expected: 7 FAIL — cleanup not yet wired.

- [ ] **Step 3: Implement**

Edit `packages/hub/src/rest/server.ts` — in `ingestHook`, after the `deps.onHookEvent?.(parsed.data);` line and **before** the `event === 'PreToolUse'` branch, add:

```ts
import { fingerprintToolInput } from '@sesshin/shared';
// (top of file)

// (in ingestHook, after onHookEvent and before PreToolUse branch:)
if (parsed.data.event === 'PostToolUse'
 || parsed.data.event === 'PostToolUseFailure'
 || parsed.data.event === 'Stop') {
  if (deps.approvals) {
    const raw = parsed.data.raw;
    const tuid = typeof raw['tool_use_id'] === 'string' ? raw['tool_use_id'] : null;
    const toolName = typeof raw['tool_name'] === 'string' ? raw['tool_name'] : null;
    const fp = (toolName && raw['tool_input'] && typeof raw['tool_input'] === 'object')
      ? fingerprintToolInput(raw['tool_input'])
      : null;
    const outcome = {
      decision: 'deny' as const,
      reason: 'sesshin: tool already moved past pending request',
    };
    const sid = parsed.data.sessionId;

    const resolvedExact = tuid ? deps.approvals.resolveByToolUseId(sid, tuid, outcome) : 0;
    const resolvedFp = (resolvedExact === 0 && toolName && fp)
      ? deps.approvals.resolveByFingerprint(sid, toolName, fp, outcome)
      : 0;
    if (resolvedExact === 0 && resolvedFp === 0 && parsed.data.event === 'Stop') {
      deps.approvals.resolveSingletonForSession(sid, outcome);
    }
    // resolved counts intentionally unused — pure internal bookkeeping.
  }
}
```

- [ ] **Step 4: Verify tests pass**

```
pnpm --filter @sesshin/hub exec vitest run src/rest/hooks.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/rest/server.ts packages/hub/src/rest/hooks.test.ts
git commit -m "hub: /hooks — 3-tier stale cleanup on PostToolUse/PostToolUseFailure/Stop"
```

---

## Phase E — Wire-up (depends on B, C, D)

### Task 15: Wire `onPermissionRequestApproval` into `wire.ts`

**Files:**
- Modify: `packages/hub/src/wire.ts`

- [ ] **Step 1: Read existing `onPreToolUseApproval` setup**

```bash
sed -n '170,260p' packages/hub/src/wire.ts
```

Note the structure: `approvals.open({...})` returns `{request, decision}`; `decision` is a Promise<ApprovalOutcome>. The existing PreToolUse adapter then maps `ApprovalOutcome.{decision: 'allow'|'deny'|'ask'}` to the PreToolUse response shape.

- [ ] **Step 2: Add the new `onPermissionRequestApproval` adapter**

Find the `createRestServer({...onPreToolUseApproval: ...})` call (around line 195 from the earlier read) and add a sibling `onPermissionRequestApproval` callback:

```ts
const rest = createRestServer({
  registry,
  // ... existing fields ...
  onPreToolUseApproval: async (env) => {
    // ... existing logic, EXTEND to read usesPermissionRequest from registry
    // and pass it as the 6th arg to shouldGatePreToolUse ...
  },
  onPermissionRequestApproval: async (env) => {
    const tool = typeof env.raw['tool_name'] === 'string' ? env.raw['tool_name'] : '';
    const rawInput = env.raw['tool_input'];
    const toolInput: Record<string, unknown> = (rawInput !== null && typeof rawInput === 'object')
      ? (rawInput as Record<string, unknown>) : {};
    const toolUseId = typeof env.raw['tool_use_id'] === 'string' ? env.raw['tool_use_id'] : undefined;
    const session = registry.get(env.sessionId);
    const knownMode = session?.substate.permissionMode;

    setCatchAllToolName(tool);
    const handler = getHandler(tool);
    const ctx: HandlerCtx = {
      permissionMode: knownMode ?? 'default',
      cwd: session?.cwd ?? process.cwd(),
      sessionAllowList: session?.sessionAllowList ?? [],
    };
    const rendered = handler.render(toolInput, ctx);

    const { request, decision } = approvals.open({
      sessionId: env.sessionId, tool, toolInput,
      ...(toolUseId !== undefined ? { toolUseId } : {}),
      onExpire: (a) => {
        wsRef?.broadcast({
          type: 'session.prompt-request.resolved',
          sessionId: a.sessionId, requestId: a.requestId, reason: 'timeout',
        });
      },
    });

    registry.updateState(env.sessionId, 'awaiting-confirmation');
    wsRef?.broadcast({
      type: 'session.prompt-request',
      sessionId: env.sessionId,
      requestId: request.requestId,
      origin: rendered.origin ?? 'permission',
      toolName: tool,
      ...(toolUseId !== undefined ? { toolUseId } : {}),
      expiresAt: request.expiresAt,
      ...(rendered.body !== undefined ? { body: rendered.body } : {}),
      questions: rendered.questions,
    });

    pendingHandlers.set(request.requestId, { handler, ctx, toolInput, tool });

    const out = await decision;
    registry.updateState(env.sessionId, 'running');
    const ui = pendingUpdatedInput.get(request.requestId);
    pendingUpdatedInput.delete(request.requestId);

    // Map ApprovalOutcome → PermissionRequest decision shape.
    // - allow → behavior: 'allow' (with optional updatedInput)
    // - deny  → behavior: 'deny' (reason becomes message)
    // - ask   → null (passthrough; PermissionRequest has no 'ask' kind)
    if (out.decision === 'allow') {
      return { behavior: 'allow', ...(ui ? { updatedInput: ui } : {}) };
    }
    if (out.decision === 'deny') {
      return { behavior: 'deny', ...(out.reason !== undefined ? { message: out.reason } : {}) };
    }
    return null;   // 'ask' → 204 passthrough
  },
});
```

- [ ] **Step 3: Update `onPreToolUseApproval` to honor `usesPermissionRequest`**

Find where `shouldGatePreToolUse(...)` is called inside `onPreToolUseApproval`. Read the session record and pass the new flag:

```ts
const usesPR = registry.get(env.sessionId)?.usesPermissionRequest === true;
if (!shouldGatePreToolUse(env.raw, knownMode, approvalGate, allowCtx, hasSubscribedClient, usesPR)) {
  return null;   // passthrough → 204
}
```

- [ ] **Step 4: Build the hub package**

```
pnpm --filter @sesshin/hub build
```

Expected: builds without TS errors.

- [ ] **Step 5: Run all hub tests to confirm no regressions**

```
pnpm --filter @sesshin/hub test
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/wire.ts
git commit -m "hub: wire onPermissionRequestApproval; PreToolUse honors usesPermissionRequest"
```

---

## Phase F — Tool-handler tests for new shape (depends on E)

### Task 16: ExitPlanMode → PermissionRequest shape

**Files:**
- Modify: `packages/hub/src/agents/claude/tool-handlers/exit-plan-mode.test.ts`

- [ ] **Step 1: Read the existing test for context**

```bash
cat packages/hub/src/agents/claude/tool-handlers/exit-plan-mode.test.ts
```

- [ ] **Step 2: Append the schema-shape tests**

Append to the file:

```ts
describe('exitPlanModeHandler — PermissionRequest output shape', () => {
  it('"yes-default" maps to {behavior:"allow"} via the wire adapter logic', () => {
    // The handler returns HookDecision; the wire.ts onPermissionRequestApproval
    // adapter (Task 15) maps HookDecision to PermissionRequest shape. We
    // assert the mapping invariants here.
    const ctx = { permissionMode: 'default' as const, cwd: '/', sessionAllowList: [] };
    const decision = exitPlanModeHandler.decide(
      [{ questionIndex: 0, selectedKeys: ['yes-default'] }],
      { plan: 'plan body' },
      ctx,
    );
    expect(decision).toEqual({ kind: 'allow' });
    // → adapter maps to: { behavior: 'allow' }
  });
  it('"yes-accept-edits" also maps to allow', () => {
    const ctx = { permissionMode: 'default' as const, cwd: '/', sessionAllowList: [] };
    const decision = exitPlanModeHandler.decide(
      [{ questionIndex: 0, selectedKeys: ['yes-accept-edits'] }],
      { plan: 'p' }, ctx,
    );
    expect(decision).toEqual({ kind: 'allow' });
  });
  it('"no" with freeText maps to deny + message', () => {
    const ctx = { permissionMode: 'default' as const, cwd: '/', sessionAllowList: [] };
    const decision = exitPlanModeHandler.decide(
      [{ questionIndex: 0, selectedKeys: ['no'], freeText: 'try X instead' }],
      { plan: 'p' }, ctx,
    );
    expect(decision).toEqual({ kind: 'deny', additionalContext: 'try X instead' });
    // → adapter maps deny+additionalContext to: { behavior: 'deny', message: <reason> }
    // (additionalContext is not currently mapped to message — see follow-up below)
  });
  it('"no" without freeText maps to plain deny', () => {
    const ctx = { permissionMode: 'default' as const, cwd: '/', sessionAllowList: [] };
    const decision = exitPlanModeHandler.decide(
      [{ questionIndex: 0, selectedKeys: ['no'] }],
      { plan: 'p' }, ctx,
    );
    expect(decision).toEqual({ kind: 'deny' });
    // → adapter maps to: { behavior: 'deny' }
  });
});
```

- [ ] **Step 3: Run tests**

```
pnpm --filter @sesshin/hub exec vitest run src/agents/claude/tool-handlers/exit-plan-mode.test.ts
```

Expected: all PASS — handler already produces these `HookDecision` shapes; the adapter mapping is asserted by route-level tests in Task 11/12.

- [ ] **Step 4: Commit**

```bash
git add packages/hub/src/agents/claude/tool-handlers/exit-plan-mode.test.ts
git commit -m "hub: ExitPlanMode — assert PermissionRequest decision-shape mapping"
```

---

### Task 17: AskUserQuestion → PermissionRequest shape (with updatedInput)

**Files:**
- Modify: `packages/hub/src/agents/claude/tool-handlers/ask-user-question.test.ts`

- [ ] **Step 1: Append test**

Append to `packages/hub/src/agents/claude/tool-handlers/ask-user-question.test.ts`:

```ts
describe('askUserQuestionHandler — PermissionRequest shape', () => {
  it('produces kind:allow with updatedInput.answers; adapter maps to behavior:allow + updatedInput', () => {
    const ctx = { permissionMode: 'default' as const, cwd: '/', sessionAllowList: [] };
    const input = {
      questions: [{
        question: 'Pick one',
        options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }],
      }],
    };
    const rendered = askUserQuestionHandler.render(input, ctx);
    const optAKey = rendered.questions[0]!.options[0]!.key;

    const decision = askUserQuestionHandler.decide(
      [{ questionIndex: 0, selectedKeys: [optAKey] }],
      input, ctx,
    );
    expect(decision.kind).toBe('allow');
    if (decision.kind === 'allow') {
      expect(decision.updatedInput).toBeDefined();
      expect((decision.updatedInput as { answers: Record<string, string> }).answers).toEqual({ 'Pick one': 'A' });
    }
    // → adapter maps to { behavior: 'allow', updatedInput: { …, answers: {…} } }
  });
  it('never produces kind:deny — its only outcome is allow with updated input', () => {
    const ctx = { permissionMode: 'default' as const, cwd: '/', sessionAllowList: [] };
    const input = {
      questions: [{
        question: 'Q',
        options: [{ label: 'X', description: '' }],
      }],
    };
    // Even with no answer, the handler returns kind:'allow' with empty answers
    // (it doesn't deny). Confirm.
    const decision = askUserQuestionHandler.decide([], input, ctx);
    expect(decision.kind).toBe('allow');
  });
});
```

- [ ] **Step 2: Run tests**

```
pnpm --filter @sesshin/hub exec vitest run src/agents/claude/tool-handlers/ask-user-question.test.ts
```

Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/hub/src/agents/claude/tool-handlers/ask-user-question.test.ts
git commit -m "hub: AskUserQuestion — assert PermissionRequest decision-shape mapping"
```

---

## Phase G — CLI install & diagnostics propagation (independent of E/F)

### Task 18: settings-tempfile — emit PermissionRequest HTTP entry

**Files:**
- Modify: `packages/cli/src/settings-tempfile.ts`
- Modify: `packages/cli/src/settings-tempfile.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `packages/cli/src/settings-tempfile.test.ts`:

```ts
describe('generateHooksOnlySettings — PermissionRequest HTTP hook', () => {
  it('emits an HTTP-typed PermissionRequest entry', () => {
    const j = JSON.parse(generateHooksOnlySettings({
      hookHandlerPath: '/usr/local/bin/sesshin-hook-handler',
      sessionId: 'abc123',
      hubUrl: 'http://127.0.0.1:9663',
      agent: 'claude-code',
    }));
    expect(j.hooks.PermissionRequest).toHaveLength(1);
    const entry = j.hooks.PermissionRequest[0].hooks[0];
    expect(entry.type).toBe('http');
    expect(entry.url).toBe('http://127.0.0.1:9663/permission/abc123');
    expect(entry.timeout).toBe(600);
  });
  it('PermissionRequest entry has no matcher key (matcher is meaningless for HTTP hook)', () => {
    const j = JSON.parse(generateHooksOnlySettings({
      hookHandlerPath: '/x', sessionId: 'abc', hubUrl: 'http://h', agent: 'claude-code',
    }));
    expect(j.hooks.PermissionRequest[0].matcher).toBeUndefined();
  });
  it('preserves existing command-hook entries alongside the HTTP hook', () => {
    const j = JSON.parse(generateHooksOnlySettings({
      hookHandlerPath: '/x', sessionId: 'abc', hubUrl: 'http://h', agent: 'claude-code',
    }));
    expect(j.hooks.PreToolUse[0].hooks[0].type).toBe('command');
    expect(j.hooks.SessionStart[0].hooks[0].type).toBe('command');
  });
});
```

- [ ] **Step 2: Run tests**

```
pnpm --filter @sesshin/cli exec vitest run src/settings-tempfile.test.ts
```

Expected: 3 FAIL.

- [ ] **Step 3: Implement**

Edit `packages/cli/src/settings-tempfile.ts`:

```ts
export function generateHooksOnlySettings(o: HooksSettingsInput): string {
  const hooks: Record<string, unknown> = {};
  for (const evt of EVENTS) {
    hooks[evt] = [{
      matcher: '*',
      hooks: [{ type: 'command', command: buildCommand(o, evt) }],
    }];
  }
  // PermissionRequest is an HTTP hook — Claude POSTs the PermissionRequest
  // payload directly to the hub. The session id is encoded in the URL path
  // because Claude's body carries Claude's native session_id (a UUID), not
  // the sesshin-side id the registry knows about.
  hooks['PermissionRequest'] = [{
    hooks: [{
      type: 'http',
      url: `${o.hubUrl}/permission/${o.sessionId}`,
      timeout: 600,
    }],
  }];
  return JSON.stringify({ hooks }, null, 2);
}
```

- [ ] **Step 4: Verify tests pass**

```
pnpm --filter @sesshin/cli exec vitest run src/settings-tempfile.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/settings-tempfile.ts packages/cli/src/settings-tempfile.test.ts
git commit -m "cli: settings-tempfile — emit PermissionRequest HTTP hook entry"
```

---

### Task 19: Diagnostics — add `usesPermissionRequest` to per-session snapshot

**Files:**
- Modify: `packages/hub/src/rest/diagnostics.ts`
- Modify: `packages/hub/src/rest/diagnostics.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `packages/hub/src/rest/diagnostics.test.ts`:

```ts
describe('GET /api/diagnostics — usesPermissionRequest', () => {
  it('exposes usesPermissionRequest=false for fresh session', async () => {
    registry.register({ id: 's2', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const r = await fetch(`http://127.0.0.1:${port}/api/diagnostics`);
    const j = await r.json();
    const s = j.sessions.find((x: { id: string }) => x.id === 's2')!;
    expect(s.usesPermissionRequest).toBe(false);
  });
  it('flips to true after registry.markUsesPermissionRequest', async () => {
    registry.register({ id: 's3', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    registry.markUsesPermissionRequest('s3');
    const r = await fetch(`http://127.0.0.1:${port}/api/diagnostics`);
    const j = await r.json();
    const s = j.sessions.find((x: { id: string }) => x.id === 's3')!;
    expect(s.usesPermissionRequest).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests**

```
pnpm --filter @sesshin/hub exec vitest run src/rest/diagnostics.test.ts
```

Expected: 2 FAIL — field absent.

- [ ] **Step 3: Implement**

Edit `packages/hub/src/rest/diagnostics.ts`:

1. Extend the return type:
   ```ts
   export function diagnosticsSnapshot(deps: DiagnosticsDeps): {
     sessions: Array<{
       id: string;
       name: string;
       state: string;
       permissionMode: string;
       sessionAllowList: string[];
       claudeAllowRules: string[];
       pendingApprovals: number;
       hasSubscribedActionsClient: boolean;
       usesPermissionRequest: boolean;     // NEW
     }>;
   }
   ```
2. In the `.map(...)` body, add the field:
   ```ts
   return {
     // … existing fields …
     usesPermissionRequest: rec.usesPermissionRequest,
   };
   ```

- [ ] **Step 4: Verify tests pass**

```
pnpm --filter @sesshin/hub exec vitest run src/rest/diagnostics.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/rest/diagnostics.ts packages/hub/src/rest/diagnostics.test.ts
git commit -m "hub: /api/diagnostics — expose usesPermissionRequest per session"
```

---

### Task 20: CLI status subcommand — extend type + non-JSON output

**Files:**
- Modify: `packages/cli/src/subcommands/status.ts`

- [ ] **Step 1: Read the existing file**

```bash
cat packages/cli/src/subcommands/status.ts
```

- [ ] **Step 2: Update the type and the line formatter**

Edit `packages/cli/src/subcommands/status.ts`:

```ts
const HUB = process.env['SESSHIN_HUB_URL'] ?? 'http://127.0.0.1:9663';

interface DiagSession {
  id: string;
  name: string;
  state: string;
  permissionMode: string;
  sessionAllowList: string[];
  claudeAllowRules: string[];
  pendingApprovals: number;
  hasSubscribedActionsClient: boolean;
  usesPermissionRequest: boolean;        // NEW
}

export async function runStatus(opts: { sessionId?: string; json?: boolean }): Promise<number> {
  const r = await fetch(`${HUB}/api/diagnostics`);
  if (!r.ok) { process.stderr.write(`hub error ${r.status}\n`); return 1; }
  const j = await r.json() as { sessions: DiagSession[] };
  const sessions = opts.sessionId ? j.sessions.filter((s) => s.id === opts.sessionId) : j.sessions;
  if (opts.json) {
    process.stdout.write(JSON.stringify({ sessions }, null, 2) + '\n');
    return 0;
  }
  for (const s of sessions) {
    const pr = s.usesPermissionRequest ? 'yes' : 'no';
    process.stdout.write(
      `${s.id}  ${s.state}  mode=${s.permissionMode}  pr=${pr}  pending=${s.pendingApprovals}  clients=${s.hasSubscribedActionsClient ? 'yes' : 'no'}\n`,
    );
    if (s.sessionAllowList.length) process.stdout.write(`  session allow:  ${s.sessionAllowList.join(', ')}\n`);
    if (s.claudeAllowRules.length)  process.stdout.write(`  claude allow:   ${s.claudeAllowRules.join(', ')}\n`);
  }
  return 0;
}
```

- [ ] **Step 3: Build**

```
pnpm --filter @sesshin/cli build
```

Expected: builds without errors.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/subcommands/status.ts
git commit -m "cli: sesshin status — surface usesPermissionRequest as pr=yes|no"
```

---

### Task 21: Slash command markdown — `/sesshin-status` mentions the flag

**Files:**
- Modify: `packages/cli/src/commands-bundle/sesshin-status.md`

- [ ] **Step 1: Edit**

Replace the contents of `packages/cli/src/commands-bundle/sesshin-status.md`:

```markdown
---
description: Show current sesshin session status (mode, gate, pending approvals, clients, permission-request gate)
allowed-tools: Bash(sesshin status:*)
---

Run this command to fetch sesshin's view of the current session:

```bash
sesshin status --session $SESSHIN_SESSION_ID --json
```

Then summarise the result for the user, including:
- current permission mode (`permissionMode`)
- gate policy and number of subscribed clients (`hasSubscribedActionsClient`)
- count of pending approvals (`pendingApprovals`)
- any active session-allow rules (`sessionAllowList`)
- whether sesshin's PermissionRequest HTTP hook has taken over for this session (`usesPermissionRequest`) — if true, PreToolUse no longer drives approvals; the PermissionRequest path does.
```

- [ ] **Step 2: Commit**

```bash
git add packages/cli/src/commands-bundle/sesshin-status.md
git commit -m "cli: /sesshin-status — instruct LLM to surface usesPermissionRequest"
```

---

## Phase H — End-to-end test (depends on E, G)

### Task 22: E2E — full PermissionRequest flow + cleanup + opt-in suppression

**Files:**
- Create: `tests/e2e/permission-request.test.ts`

- [ ] **Step 1: Look at existing e2e structure for the harness pattern**

```bash
ls tests/e2e/
cat tests/e2e/run-e2e.mjs 2>/dev/null | head -40
```

Pick the pattern used by an existing e2e (likely spawns the hub binary on a free port and POSTs against it).

- [ ] **Step 2: Write the test**

Create `tests/e2e/permission-request.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

// NB: the hub binary path is set up by the e2e harness (see tests/e2e/run-e2e.mjs).
// Here we spawn it directly so the test is self-contained.
const HUB_BIN = process.env['SESSHIN_HUB_BIN'] ?? './packages/hub/bin/sesshin-hub';

let hub: ChildProcess;
let port: number;

async function waitForHealth(p: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/api/health`);
      if (r.ok) return;
    } catch { /* not ready */ }
    await sleep(100);
  }
  throw new Error('hub did not come up');
}

beforeEach(async () => {
  port = 9000 + Math.floor(Math.random() * 100);
  hub = spawn(HUB_BIN, [], {
    env: { ...process.env, SESSHIN_INTERNAL_PORT: String(port) },
    stdio: 'pipe',
  });
  await waitForHealth(port);
});
afterEach(async () => {
  hub.kill('SIGTERM');
  await new Promise((r) => hub.once('exit', r));
});

const register = async (id: string): Promise<void> => {
  const r = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id, name: 'e2e', agent: 'claude-code', cwd: '/', pid: process.pid,
      sessionFilePath: '/tmp/x',
    }),
  });
  expect(r.status).toBe(201);
};

describe('e2e: PermissionRequest', () => {
  it('full flow — POST /permission/:sid returns decision shape; cleanup on PostToolUse', async () => {
    await register('e2e1');

    // Permission request — no client to answer; hub falls back to its
    // configured timeout decision. With short timeout via env, the test
    // doesn't have to wait the full default. Use 2s for the test.
    // (The hub's default is 60s; for e2e we accept the full timeout if
    // the test runner has time, OR run cleanup-via-PostToolUse first.)

    // Race: kick off PermissionRequest, then immediately fire PostToolUse with
    // matching tool_use_id. The cleanup branch should resolve the pending
    // request as deny within milliseconds.
    const prPromise = fetch(`http://127.0.0.1:${port}/permission/e2e1`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: 'claude-uuid', hook_event_name: 'PermissionRequest',
        tool_name: 'Bash', tool_input: { command: 'ls' },
        tool_use_id: 'tu_e2e_1',
      }),
    });
    // Give the hub a moment to register the pending entry.
    await sleep(50);

    await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: 'claude-code', sessionId: 'e2e1', ts: Date.now(),
        event: 'PostToolUse',
        raw: { nativeEvent: 'PostToolUse', tool_name: 'Bash',
               tool_input: { command: 'ls' }, tool_use_id: 'tu_e2e_1' },
      }),
    });

    const r = await prPromise;
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.hookSpecificOutput.hookEventName).toBe('PermissionRequest');
    expect(j.hookSpecificOutput.decision.behavior).toBe('deny');
    expect(j.hookSpecificOutput.decision.message).toContain('moved past pending request');
  });

  it('opt-in: after a /permission hit, /hooks PreToolUse passes through', async () => {
    await register('e2e2');

    // First, send a PermissionRequest (any short payload that will
    // resolve immediately via cleanup or timeout). For brevity, use
    // a passthrough scenario: register, mark, check diagnostics.
    await fetch(`http://127.0.0.1:${port}/permission/e2e2`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: 'cu', hook_event_name: 'PermissionRequest',
        tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'tu_x',
      }),
    });
    // Cleanup the dangling pending entry so the test doesn't wait for timeout
    await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: 'claude-code', sessionId: 'e2e2', ts: Date.now(), event: 'Stop',
        raw: { nativeEvent: 'Stop' },
      }),
    });

    // Diagnostics should now show usesPermissionRequest=true.
    const dr = await fetch(`http://127.0.0.1:${port}/api/diagnostics`);
    const dj = await dr.json();
    const sess = dj.sessions.find((s: { id: string }) => s.id === 'e2e2');
    expect(sess.usesPermissionRequest).toBe(true);

    // Now a PreToolUse should 204-passthrough (no permissionDecision).
    const pre = await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: 'claude-code', sessionId: 'e2e2', ts: Date.now(), event: 'PreToolUse',
        raw: {
          nativeEvent: 'PreToolUse', tool_name: 'Bash',
          tool_input: { command: 'rm -rf /' }, permission_mode: 'default',
        },
      }),
    });
    expect(pre.status).toBe(204);
  });

  it('different session has no opt-in — still uses PreToolUse path', async () => {
    await register('e2e3');
    const dr = await fetch(`http://127.0.0.1:${port}/api/diagnostics`);
    const dj = await dr.json();
    const sess = dj.sessions.find((s: { id: string }) => s.id === 'e2e3');
    expect(sess.usesPermissionRequest).toBe(false);
  });
});
```

- [ ] **Step 3: Run e2e**

```
pnpm --filter @sesshin/hub build && pnpm --filter @sesshin/shared build
pnpm exec vitest run tests/e2e/permission-request.test.ts
```

Expected: all 3 PASS. (If the harness uses a different runner — e.g., `node tests/e2e/run-e2e.mjs` — adapt the spawn command per the existing pattern observed in Step 1.)

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/permission-request.test.ts
git commit -m "test(e2e): full PermissionRequest flow — happy path, opt-in, cleanup"
```

---

## Phase Z — Final integration check

### Task 23: Run full test suite + build

- [ ] **Step 1: Build everything**

```
pnpm build
```

Expected: success.

- [ ] **Step 2: Run all tests**

```
pnpm test
```

Expected: all packages PASS.

- [ ] **Step 3: Lint / typecheck (if there's a script)**

Check `package.json` scripts:
```bash
grep -E "lint|typecheck|tsc" packages/*/package.json
```

Run any present:
```bash
pnpm -r exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Final commit (if any cleanup needed)**

If any tweak was needed (e.g. minor type adjustments surfaced by the full build), commit them now:
```bash
git add -p
git commit -m "polish: <what was needed>"
```

---

## Self-review checklist

After all tasks, verify against the spec:

- [ ] §1.1 — `POST /permission/:sessionId` route accepts native PermissionRequest body and returns `decision` shape. ✅ Tasks 11, 12.
- [ ] §1.2 — Per-session opt-in (auto-detect on first `/permission`); PreToolUse short-circuits for opt-in sessions. ✅ Tasks 8, 9, 11, 15.
- [ ] §1.3 — Schema split: discriminated union in shared/, separate route, separate callback. ✅ Tasks 3, 11, 13.
- [ ] §1.4 — ExitPlanMode + AskUserQuestion produce PermissionRequest-shape JSON via adapter. ✅ Tasks 16, 17 (handler-level), Task 11 (route-level wire shape).
- [ ] §1.5 — Three-tier stale cleanup. ✅ Tasks 5, 6, 7, 14.
- [ ] §1 (extras) — Codex sanitizer scaffold, 512 KB body cap. ✅ Tasks 10, 12.
- [ ] §4.1 — `PermissionRequest` and `PostToolUseFailure` in normalized vocabulary. ✅ Task 1.
- [ ] §4.4 — bounded normalize + sha1. ✅ Task 2.
- [ ] §7 — `usesPermissionRequest` in diagnostics; CLI status; slash command. ✅ Tasks 19, 20, 21.
- [ ] §8 — temp-file emits PermissionRequest HTTP entry. ✅ Task 18.
- [ ] §9 — failure modes covered by Task 12.
- [ ] E2E coverage. ✅ Task 22.

If any spec section has no task pointer, add one before handing the plan to an executor.

---

## Notes on approach

- Tasks are ordered for dependency satisfaction (A → B → D for routes; C is independent; E depends on B/D; F depends on E; G is mostly independent of E/F).
- Each task is atomic — every commit leaves the tree green. If a task is interrupted mid-step, the worktree should still build.
- TDD discipline: write the assertion that hurts, watch it fail, then implement. Don't write implementation first and then "tests for it" — that pattern produces tests that test the implementation rather than the requirement.
- The plan deliberately keeps `PendingApproval.tool` (no rename to `toolName`) to avoid touching `wire.ts` broadcasts and unrelated WS code. The spec mentioned the rename as nice-to-have; functionality is unaffected. Spec doc should be updated to drop the rename note in a follow-up.
