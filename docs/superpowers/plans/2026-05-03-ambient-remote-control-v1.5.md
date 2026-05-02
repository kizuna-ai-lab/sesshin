# Ambient Remote Control v1.5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface every Claude Code permission prompt and interactive tool call to remote sesshin clients with full mode awareness, while staying transparent when no client is around.

**Architecture:** JSONL `permission-mode` records flow into `Substate.permissionMode`; PreToolUse hook is intercepted by per-tool handlers that produce wire-uniform `session.prompt-request` messages mirroring claude's own `PromptRequest` shape; approval gates on (mode, client presence, allow lists, tool class); subscribed-client tracking + last-disconnect releases pending approvals back to TUI; CLI subcommands and `/sesshin-*` slash commands provide diagnostics + control.

**Tech Stack:** TypeScript / Node 22+ / pnpm workspaces / vitest / Preact + Vite (debug-web) / zod for schemas / ws for WebSocket / node-pty for PTY wrap.

**Spec:** `docs/superpowers/specs/2026-05-03-ambient-remote-control-v1.5-design.md` (committed at a0b1741).

---

## File map

### packages/shared (modify)
- `src/session.ts` — add `permissionMode` to `SubstateSchema` (Task 1)
- `src/protocol.ts` — replace `SessionConfirmation*` with `SessionPromptRequest*` + `PromptResponse` upstream (Task 4)

### packages/hub
- **NEW** `src/agents/claude/permission-rules.ts` (+`*.test.ts`) — port of claude's rule parser/formatter/matcher (Task 6)
- **NEW** `src/agents/claude/tool-handlers/types.ts` — `ToolHandler` interface (Task 5)
- **NEW** `src/agents/claude/tool-handlers/registry.ts` (+`*.test.ts`) — name → handler dispatch (Task 5)
- **NEW** `src/agents/claude/tool-handlers/bash.ts` (+`*.test.ts`) (Task 5)
- **NEW** `src/agents/claude/tool-handlers/file-edit.ts` (+`*.test.ts`) — Edit/Write/MultiEdit/NotebookEdit (Task 5)
- **NEW** `src/agents/claude/tool-handlers/web-fetch.ts` (+`*.test.ts`) (Task 5)
- **NEW** `src/agents/claude/tool-handlers/ask-user-question.ts` (+`*.test.ts`) (Task 5)
- **NEW** `src/agents/claude/tool-handlers/exit-plan-mode.ts` (+`*.test.ts`) (Task 5)
- **NEW** `src/agents/claude/tool-handlers/catch-all.ts` (+`*.test.ts`) (Task 5)
- **NEW** `src/observers/jsonl-mode-tracker.ts` (+`*.test.ts`) (Task 1)
- **NEW** `src/rest/diagnostics.ts` (+`*.test.ts`) (Task 9)
- **MODIFY** `src/agents/claude/normalize-jsonl.ts` (+`*.test.ts`) — `permission-mode` case (Task 1)
- **MODIFY** `src/agents/claude/approval-policy.ts` (+`*.test.ts`) — multi-input signature (Task 3)
- **MODIFY** `src/registry/session-registry.ts` (+`*.test.ts`) — `setPermissionMode`, `sessionAllowList`, `claudeAllowRules` (Tasks 1, 6)
- **MODIFY** `src/approval-manager.ts` — `cancelOnLastClientGone` (Task 7)
- **MODIFY** `src/wire.ts` — wire mode tracker, client tracker, last-disconnect, register fields (Tasks 1–9)
- **MODIFY** `src/rest/server.ts` — `initialPermissionMode` + `claudeAllowRules` in register, new diagnostics routes (Tasks 2, 9, 11)
- **MODIFY** `src/ws/{server,connection}.ts` — capabilities + `prompt-response` upstream + client subscription tracking (Tasks 4, 7)

### packages/cli
- **NEW** `src/read-claude-settings.ts` (+`*.test.ts`) (Task 2)
- **NEW** `src/parse-permission-mode-flag.ts` (+`*.test.ts`) (Task 2)
- **NEW** `src/subcommands/{status,clients,history,trust,gate,pin,quiet}.ts` (Tasks 9, 11)
- **NEW** `src/commands-bundle/sesshin-{status,clients,history,trust,gate,pin,quiet}.md` (Tasks 10, 11)
- **MODIFY** `src/main.ts` — subcommand dispatch (Tasks 9, 11)
- **MODIFY** `src/claude.ts` — register body fields, plugin entry in tempfile (Tasks 2, 10)
- **MODIFY** `src/settings-tempfile.ts` — optional `enabledPlugins` block (Task 10)

### packages/debug-web
- **DELETE** `src/components/ConfirmationPanel.tsx` (Task 8)
- **NEW** `src/components/InteractionPanel.tsx` (+`*.test.tsx`) (Task 8)
- **NEW** `src/components/ModeBadge.tsx` (+`*.test.tsx`) (Task 8)
- **MODIFY** `src/store.ts` — rename to `promptRequestsBySession` (Task 8)
- **MODIFY** `src/ws-client.ts` — handle new message types (Tasks 4, 8)
- **MODIFY** `src/components/SessionDetail.tsx` — render `<ModeBadge>` + `<InteractionPanel>` (Task 8)

### tests/e2e
- **MODIFY** `stub-claude/index.mjs` — emit `permission-mode` JSONL records, support mid-session mode flips (Task 1)
- **MODIFY** `run-e2e.mjs` — handle renamed messages, mode-change scenarios (Task 4)

### docs
- **MODIFY** `README.md`, `docs/architecture.md` (Task 12)

---

## Task 1: Mode tracking foundation

**Goal:** `permission-mode` JSONL records flow into `Substate.permissionMode`. Web sees it via existing `session.state` broadcasts.

**Files:**
- Modify: `packages/shared/src/session.ts`
- Modify: `packages/hub/src/agents/claude/normalize-jsonl.ts`
- Modify: `packages/hub/src/agents/claude/normalize-jsonl.test.ts`
- Modify: `packages/hub/src/registry/session-registry.ts`
- Modify: `packages/hub/src/registry/session-registry.test.ts`
- Create: `packages/hub/src/observers/jsonl-mode-tracker.ts`
- Create: `packages/hub/src/observers/jsonl-mode-tracker.test.ts`
- Modify: `packages/hub/src/wire.ts`
- Modify: `tests/e2e/stub-claude/index.mjs`

- [ ] **Step 1: Extend `SubstateSchema` with `permissionMode`**

Open `packages/shared/src/session.ts`, find the `SubstateSchema` definition. Add `PermissionModeEnum` above it and add the field with a default:

```typescript
export const PermissionModeEnum = z.enum([
  'default','auto','acceptEdits','bypassPermissions','dontAsk','plan',
]);
export type PermissionMode = z.infer<typeof PermissionModeEnum>;

export const SubstateSchema = z.object({
  currentTool:            z.string().nullable(),
  lastTool:               z.string().nullable(),
  lastFileTouched:        z.string().nullable(),
  lastCommandRun:         z.string().nullable(),
  elapsedSinceProgressMs: z.number().int(),
  tokensUsedTurn:         z.number().int().nullable(),
  connectivity:           z.enum(['ok','degraded','offline']),
  stalled:                z.boolean(),
  permissionMode:         PermissionModeEnum.default('default'),
});
```

- [ ] **Step 2: Run shared package tests**

```bash
pnpm --filter @sesshin/shared test
```
Expected: PASS (additive change).

- [ ] **Step 3: Write failing test for JSONL mode-change parsing**

Open `packages/hub/src/agents/claude/normalize-jsonl.test.ts`, add a test:

```typescript
it('emits agent-internal mode-change event for permission-mode JSONL records', () => {
  const line = JSON.stringify({ type: 'permission-mode', permissionMode: 'auto', sessionId: 'claude-uuid' });
  const e = jsonlLineToEvent('s1', line);
  expect(e).toMatchObject({
    sessionId: 's1',
    kind: 'agent-internal',
    payload: { phase: 'mode-change', mode: 'auto' },
    source: 'observer:session-file-tail',
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

```bash
pnpm --filter @sesshin/hub test -- normalize-jsonl
```
Expected: FAIL — current code emits a generic `agent-internal` with full raw payload.

- [ ] **Step 5: Add the case in `normalize-jsonl.ts`**

In `packages/hub/src/agents/claude/normalize-jsonl.ts`, add this branch right after the early `parsed` validation, before the `parsed.type === 'user'` branch:

```typescript
if (parsed.type === 'permission-mode') {
  const mode = typeof parsed.permissionMode === 'string' ? parsed.permissionMode : 'default';
  return {
    eventId, sessionId, ts,
    kind: 'agent-internal',
    payload: { phase: 'mode-change', mode },
    source: 'observer:session-file-tail',
  };
}
```

- [ ] **Step 6: Re-run; expected PASS**

```bash
pnpm --filter @sesshin/hub test -- normalize-jsonl
```

- [ ] **Step 7: Write failing test for `setPermissionMode`**

In `packages/hub/src/registry/session-registry.test.ts`, add:

```typescript
it('setPermissionMode updates substate, emits substate-changed, idempotent on no-op', () => {
  const r = makeReg();
  r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
  const events: string[] = [];
  r.on('substate-changed', (s) => events.push(s.substate.permissionMode));
  expect(r.setPermissionMode('s1', 'auto')).toBe(true);
  expect(r.get('s1')?.substate.permissionMode).toBe('auto');
  expect(r.setPermissionMode('s1', 'auto')).toBe(false); // no-op
  expect(events).toEqual(['auto']);
  expect(r.setPermissionMode('missing', 'plan')).toBe(false);
});
```

- [ ] **Step 8: Run; verify FAIL**

```bash
pnpm --filter @sesshin/hub test -- session-registry
```

- [ ] **Step 9: Implement `setPermissionMode`**

In `packages/hub/src/registry/session-registry.ts`, add the method (next to `patchSubstate`):

```typescript
setPermissionMode(id: string, mode: PermissionMode): boolean {
  const s = this.sessions.get(id);
  if (!s) return false;
  if (s.substate.permissionMode === mode) return false;
  s.substate.permissionMode = mode;
  this.emit('substate-changed', this.publicView(s));
  return true;
}
```

Add the import:
```typescript
import type { PermissionMode } from '@sesshin/shared';
```

Also update `defaultSubstate()` to include the new field:

```typescript
function defaultSubstate(): Substate {
  return {
    currentTool: null, lastTool: null, lastFileTouched: null, lastCommandRun: null,
    elapsedSinceProgressMs: 0, tokensUsedTurn: null,
    connectivity: 'ok', stalled: false,
    permissionMode: 'default',
  };
}
```

- [ ] **Step 10: Re-run; verify PASS**

```bash
pnpm --filter @sesshin/hub test -- session-registry
```

- [ ] **Step 11: Write failing test for `jsonl-mode-tracker`**

Create `packages/hub/src/observers/jsonl-mode-tracker.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { wireJsonlModeTracker } from './jsonl-mode-tracker.js';
import { EventBus } from '../event-bus.js';
import { SessionRegistry } from '../registry/session-registry.js';

describe('jsonl-mode-tracker', () => {
  it('updates registry permissionMode when bus emits agent-internal mode-change', () => {
    const bus = new EventBus();
    const reg = new SessionRegistry();
    reg.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    wireJsonlModeTracker({ bus, registry: reg });
    bus.emit({
      eventId: 'e1', sessionId: 's1', ts: 1,
      kind: 'agent-internal',
      payload: { phase: 'mode-change', mode: 'auto' },
      source: 'observer:session-file-tail',
    });
    expect(reg.get('s1')?.substate.permissionMode).toBe('auto');
  });

  it('ignores agent-internal events without phase=mode-change', () => {
    const bus = new EventBus();
    const reg = new SessionRegistry();
    reg.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    wireJsonlModeTracker({ bus, registry: reg });
    bus.emit({
      eventId: 'e1', sessionId: 's1', ts: 1,
      kind: 'agent-internal',
      payload: { phase: 'session-start' },
      source: 'observer:hook-ingest',
    });
    expect(reg.get('s1')?.substate.permissionMode).toBe('default');
  });
});
```

- [ ] **Step 12: Run; verify FAIL**

```bash
pnpm --filter @sesshin/hub test -- jsonl-mode-tracker
```
Expected: FAIL — module doesn't exist.

- [ ] **Step 13: Implement `jsonl-mode-tracker`**

Create `packages/hub/src/observers/jsonl-mode-tracker.ts`:

```typescript
import type { EventBus } from '../event-bus.js';
import type { SessionRegistry } from '../registry/session-registry.js';
import type { PermissionMode } from '@sesshin/shared';

const VALID_MODES = new Set<PermissionMode>([
  'default','auto','acceptEdits','bypassPermissions','dontAsk','plan',
]);

export function wireJsonlModeTracker(deps: { bus: EventBus; registry: SessionRegistry }): void {
  deps.bus.on((e) => {
    if (e.kind !== 'agent-internal') return;
    if (e.payload['phase'] !== 'mode-change') return;
    const m = e.payload['mode'];
    if (typeof m !== 'string' || !VALID_MODES.has(m as PermissionMode)) return;
    deps.registry.setPermissionMode(e.sessionId, m as PermissionMode);
  });
}
```

- [ ] **Step 14: Re-run; verify PASS**

```bash
pnpm --filter @sesshin/hub test -- jsonl-mode-tracker
```

- [ ] **Step 15: Wire into `wire.ts`**

In `packages/hub/src/wire.ts`, add the import and call after the `wireStateMachine` call:

```typescript
import { wireJsonlModeTracker } from './observers/jsonl-mode-tracker.js';

// …existing wireStateMachine line…
wireJsonlModeTracker({ bus, registry });   // NB: use raw bus, not dedupedBus — agent-internal passes dedup but we don't care
```

- [ ] **Step 16: Update stub-claude to emit a `permission-mode` record**

In `tests/e2e/stub-claude/index.mjs`, after the `fireHook('SessionStart', …)` and before `writeJsonl({type:'user', …})`, add:

```javascript
writeJsonl({ type: 'permission-mode', permissionMode: 'default', sessionId });
```

- [ ] **Step 17: Run full test + e2e**

```bash
pnpm test && pnpm e2e
```
Expected: all green.

- [ ] **Step 18: Commit**

```bash
git add packages/shared/src/session.ts \
  packages/hub/src/agents/claude/normalize-jsonl.ts packages/hub/src/agents/claude/normalize-jsonl.test.ts \
  packages/hub/src/registry/session-registry.ts packages/hub/src/registry/session-registry.test.ts \
  packages/hub/src/observers/jsonl-mode-tracker.ts packages/hub/src/observers/jsonl-mode-tracker.test.ts \
  packages/hub/src/wire.ts \
  tests/e2e/stub-claude/index.mjs
git commit -m "feat(shared,hub): track permissionMode on Substate from JSONL"
```

---

## Task 2: Initial mode seeding

**Goal:** When sesshin registers a session, seed `Substate.permissionMode` from settings + `--permission-mode` flag, so PreToolUse hooks fired before the first JSONL `permission-mode` record see the right mode.

**Files:**
- Create: `packages/cli/src/read-claude-settings.ts`
- Create: `packages/cli/src/read-claude-settings.test.ts`
- Create: `packages/cli/src/parse-permission-mode-flag.ts`
- Create: `packages/cli/src/parse-permission-mode-flag.test.ts`
- Modify: `packages/cli/src/claude.ts`
- Modify: `packages/hub/src/rest/server.ts`
- Modify: `packages/hub/src/rest/sessions.test.ts`
- Modify: `packages/hub/src/registry/session-registry.ts`

- [ ] **Step 1: Test `parse-permission-mode-flag`**

Create `packages/cli/src/parse-permission-mode-flag.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parsePermissionModeFlag } from './parse-permission-mode-flag.js';

describe('parsePermissionModeFlag', () => {
  it('returns null when flag not present', () => {
    expect(parsePermissionModeFlag(['hello'])).toBeNull();
  });
  it('parses --permission-mode <value>', () => {
    expect(parsePermissionModeFlag(['--permission-mode', 'auto'])).toBe('auto');
  });
  it('parses --permission-mode=value', () => {
    expect(parsePermissionModeFlag(['--permission-mode=acceptEdits'])).toBe('acceptEdits');
  });
  it('returns null for unknown values', () => {
    expect(parsePermissionModeFlag(['--permission-mode', 'bogus'])).toBeNull();
  });
});
```

- [ ] **Step 2: Run; FAIL**

```bash
pnpm --filter @sesshin/cli test -- parse-permission-mode-flag
```

- [ ] **Step 3: Implement**

Create `packages/cli/src/parse-permission-mode-flag.ts`:

```typescript
import type { PermissionMode } from '@sesshin/shared';

const VALID = new Set(['default','auto','acceptEdits','bypassPermissions','dontAsk','plan']);

export function parsePermissionModeFlag(args: readonly string[]): PermissionMode | null {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--permission-mode') {
      const v = args[i + 1];
      if (typeof v === 'string' && VALID.has(v)) return v as PermissionMode;
      return null;
    }
    if (typeof a === 'string' && a.startsWith('--permission-mode=')) {
      const v = a.slice('--permission-mode='.length);
      if (VALID.has(v)) return v as PermissionMode;
      return null;
    }
  }
  return null;
}
```

- [ ] **Step 4: Run; PASS**

```bash
pnpm --filter @sesshin/cli test -- parse-permission-mode-flag
```

- [ ] **Step 5: Test `read-claude-settings`**

Create `packages/cli/src/read-claude-settings.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClaudeSettings } from './read-claude-settings.js';

let HOME: string, CWD: string;
beforeEach(() => {
  HOME = mkdtempSync(join(tmpdir(), 'sesshin-test-home-'));
  CWD  = mkdtempSync(join(tmpdir(), 'sesshin-test-cwd-'));
});
afterEach(() => { rmSync(HOME, { recursive: true, force: true }); rmSync(CWD, { recursive: true, force: true }); });

describe('readClaudeSettings', () => {
  it('returns empty defaults when no settings exist', () => {
    expect(readClaudeSettings({ home: HOME, cwd: CWD })).toEqual({ defaultMode: null, allowRules: [] });
  });

  it('reads user defaultMode from ~/.claude/settings.json', () => {
    mkdirSync(join(HOME, '.claude'), { recursive: true });
    writeFileSync(join(HOME, '.claude/settings.json'),
      JSON.stringify({ permissions: { defaultMode: 'auto', allow: ['Bash(git log:*)'] } }));
    expect(readClaudeSettings({ home: HOME, cwd: CWD })).toEqual({
      defaultMode: 'auto', allowRules: ['Bash(git log:*)'],
    });
  });

  it('project settings override user defaultMode and merge allow rules', () => {
    mkdirSync(join(HOME, '.claude'), { recursive: true });
    writeFileSync(join(HOME, '.claude/settings.json'),
      JSON.stringify({ permissions: { defaultMode: 'auto', allow: ['Bash(git log:*)'] } }));
    mkdirSync(join(CWD, '.claude'), { recursive: true });
    writeFileSync(join(CWD, '.claude/settings.json'),
      JSON.stringify({ permissions: { defaultMode: 'default', allow: ['Edit(/tmp/*)'] } }));
    expect(readClaudeSettings({ home: HOME, cwd: CWD })).toEqual({
      defaultMode: 'default',
      allowRules: ['Bash(git log:*)', 'Edit(/tmp/*)'],
    });
  });

  it('tolerates malformed JSON', () => {
    mkdirSync(join(HOME, '.claude'), { recursive: true });
    writeFileSync(join(HOME, '.claude/settings.json'), '{ broken');
    expect(readClaudeSettings({ home: HOME, cwd: CWD })).toEqual({ defaultMode: null, allowRules: [] });
  });

  it('ignores invalid defaultMode values', () => {
    mkdirSync(join(HOME, '.claude'), { recursive: true });
    writeFileSync(join(HOME, '.claude/settings.json'),
      JSON.stringify({ permissions: { defaultMode: 'wat' } }));
    expect(readClaudeSettings({ home: HOME, cwd: CWD }).defaultMode).toBeNull();
  });
});
```

- [ ] **Step 6: Run; FAIL**

```bash
pnpm --filter @sesshin/cli test -- read-claude-settings
```

- [ ] **Step 7: Implement**

Create `packages/cli/src/read-claude-settings.ts`:

```typescript
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PermissionMode } from '@sesshin/shared';

const VALID_MODES = new Set(['default','auto','acceptEdits','bypassPermissions','dontAsk','plan']);

export interface ClaudeSettings { defaultMode: PermissionMode | null; allowRules: string[] }

function tryRead(path: string): any | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

function extractMode(j: any): PermissionMode | null {
  const m = j?.permissions?.defaultMode;
  return typeof m === 'string' && VALID_MODES.has(m) ? (m as PermissionMode) : null;
}

function extractAllow(j: any): string[] {
  const a = j?.permissions?.allow;
  return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [];
}

export function readClaudeSettings(opts: { home: string; cwd: string }): ClaudeSettings {
  const userJson    = tryRead(join(opts.home, '.claude/settings.json'));
  const projectJson = tryRead(join(opts.cwd,  '.claude/settings.json'));
  return {
    defaultMode: extractMode(projectJson) ?? extractMode(userJson),
    allowRules: [...extractAllow(userJson), ...extractAllow(projectJson)],
  };
}
```

- [ ] **Step 8: Run; PASS**

```bash
pnpm --filter @sesshin/cli test -- read-claude-settings
```

- [ ] **Step 9: Wire seed into CLI register call**

In `packages/cli/src/claude.ts`, replace the existing register block. Add imports:

```typescript
import { readClaudeSettings } from './read-claude-settings.js';
import { parsePermissionModeFlag } from './parse-permission-mode-flag.js';
```

Replace the register block (around line 56-61 in current code):

```typescript
const cwd = process.cwd();
const sfp = sessionFilePath({ home: homedir(), cwd, sessionId });
const claudeSettings = readClaudeSettings({ home: homedir(), cwd });
const initialPermissionMode =
  parsePermissionModeFlag(extraArgs) ?? claudeSettings.defaultMode ?? 'default';
const reg = await fetch(`${HUB_URL}/api/sessions`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    id: sessionId, name: `claude (${cwd})`, agent: 'claude-code', cwd,
    pid: process.pid, sessionFilePath: sfp,
    initialPermissionMode,
    claudeAllowRules: claudeSettings.allowRules,
  }),
});
if (!reg.ok) throw new Error(`hub registration failed: ${reg.status}`);
```

- [ ] **Step 10: Test that hub register accepts the new fields**

In `packages/hub/src/rest/sessions.test.ts`, add:

```typescript
it('accepts initialPermissionMode + claudeAllowRules in register body', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'sNew', name: 'n', agent: 'claude-code', cwd: '/', pid: 99,
      sessionFilePath: '/x.jsonl',
      initialPermissionMode: 'auto',
      claudeAllowRules: ['Bash(git log:*)'],
    }),
  });
  expect(r.status).toBe(201);
  const list = await (await fetch(`http://127.0.0.1:${port}/api/sessions`)).json();
  expect(list.find((s: any) => s.id === 'sNew')?.substate.permissionMode).toBe('auto');
});
```

- [ ] **Step 11: Run; FAIL**

```bash
pnpm --filter @sesshin/hub test -- sessions
```

- [ ] **Step 12: Extend `RegisterBody` schema**

In `packages/hub/src/rest/server.ts`:

```typescript
const RegisterBody = z.object({
  id:                    z.string(),
  name:                  z.string(),
  agent:                 z.enum(['claude-code', 'codex', 'gemini', 'other']),
  cwd:                   z.string(),
  pid:                   z.number().int(),
  sessionFilePath:       z.string(),
  initialPermissionMode: z.enum(['default','auto','acceptEdits','bypassPermissions','dontAsk','plan']).optional(),
  claudeAllowRules:      z.array(z.string()).optional(),
});
```

- [ ] **Step 13: Honour the fields in `registerSession`**

In `packages/hub/src/rest/server.ts`, modify `registerSession` body handling:

```typescript
const rec = deps.registry.register(parsed.data);
if (parsed.data.initialPermissionMode) {
  deps.registry.setPermissionMode(rec.id, parsed.data.initialPermissionMode);
}
if (parsed.data.claudeAllowRules) {
  deps.registry.setClaudeAllowRules(rec.id, parsed.data.claudeAllowRules);
}
res.writeHead(201, { 'content-type': 'application/json' })
   .end(JSON.stringify({ id: rec.id, registeredAt: rec.startedAt }));
```

- [ ] **Step 14: Add `setClaudeAllowRules` to registry**

In `packages/hub/src/registry/session-registry.ts`, add to `SessionRecord`:

```typescript
export interface SessionRecord extends SessionInfo {
  sessionFilePath: string;
  fileTailCursor: number;
  lastHeartbeat: number;
  claudeAllowRules: string[];
  sessionAllowList: string[];
}
```

In `register()`, initialize:
```typescript
claudeAllowRules: [],
sessionAllowList: [],
```

Add the setter:
```typescript
setClaudeAllowRules(id: string, rules: string[]): boolean {
  const s = this.sessions.get(id);
  if (!s) return false;
  s.claudeAllowRules = [...rules];
  return true;
}
```

- [ ] **Step 15: Run; PASS**

```bash
pnpm --filter @sesshin/hub test -- sessions
```

- [ ] **Step 16: Run full suite + e2e**

```bash
pnpm test && pnpm e2e
```

- [ ] **Step 17: Commit**

```bash
git add packages/cli/src/read-claude-settings.ts packages/cli/src/read-claude-settings.test.ts \
  packages/cli/src/parse-permission-mode-flag.ts packages/cli/src/parse-permission-mode-flag.test.ts \
  packages/cli/src/claude.ts \
  packages/hub/src/rest/server.ts packages/hub/src/rest/sessions.test.ts \
  packages/hub/src/registry/session-registry.ts
git commit -m "feat(cli,hub): seed permissionMode and claudeAllowRules at session register"
```

---

## Task 3: Approval policy with authoritative mode

**Goal:** `approval-policy.ts` now consults the registry's known mode instead of relying on the hook payload (which collapses `auto → default`). Auto-mode regression closes.

**Files:**
- Modify: `packages/hub/src/agents/claude/approval-policy.ts`
- Modify: `packages/hub/src/agents/claude/approval-policy.test.ts`
- Modify: `packages/hub/src/wire.ts`

- [ ] **Step 1: Update tests for new signature**

Replace the body of `packages/hub/src/agents/claude/approval-policy.test.ts` matrix tests with the new shape. Add this block at the top of the existing `describe('shouldGatePreToolUse — auto policy')` block:

```typescript
it('does NOT gate when knownMode is auto even if hook says default', () => {
  expect(shouldGatePreToolUse(
    { permission_mode: 'default', tool_name: 'Bash' },
    'auto',          // knownMode
    'auto',          // policy
  )).toBe(false);
});

it('gates when knownMode is default and tool is gated', () => {
  expect(shouldGatePreToolUse(
    { permission_mode: 'default', tool_name: 'Bash' },
    'default', 'auto',
  )).toBe(true);
});

it('falls back to hookRawMode when knownMode is null', () => {
  expect(shouldGatePreToolUse(
    { permission_mode: 'acceptEdits', tool_name: 'Bash' },
    null, 'auto',
  )).toBe(false);
});
```

Update the existing tests in the file to pass `null` (or appropriate mode) as the new second positional argument.

- [ ] **Step 2: Run; FAIL**

```bash
pnpm --filter @sesshin/hub test -- approval-policy
```

- [ ] **Step 3: Update `shouldGatePreToolUse` signature**

In `packages/hub/src/agents/claude/approval-policy.ts`, replace the function:

```typescript
import type { PermissionMode } from '@sesshin/shared';

export function shouldGatePreToolUse(
  raw: Record<string, unknown>,
  knownMode: PermissionMode | null,
  policy: ApprovalGatePolicy,
): boolean {
  if (policy === 'disabled') return false;
  if (policy === 'always')   return true;
  // policy === 'auto'
  const mode: string =
    knownMode ??
    (typeof raw['permission_mode'] === 'string' ? raw['permission_mode'] : 'default');
  if (AUTO_EXECUTE_MODES.has(mode)) return false;
  if (mode === 'plan')              return false;
  const tool = typeof raw['tool_name'] === 'string' ? raw['tool_name'] : '';
  return GATED_TOOLS.has(tool);
}
```

- [ ] **Step 4: Update call site in `wire.ts`**

In `packages/hub/src/wire.ts`, find the `onPreToolUseApproval` callback and update the `shouldGatePreToolUse` call:

```typescript
onPreToolUseApproval: async (env) => {
  const session = registry.get(env.sessionId);
  const knownMode = session?.substate.permissionMode ?? null;
  if (!shouldGatePreToolUse(env.raw, knownMode, approvalGate)) return null;
  // …rest unchanged…
},
```

- [ ] **Step 5: Run; PASS**

```bash
pnpm --filter @sesshin/hub test -- approval-policy
pnpm test && pnpm e2e
```

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/agents/claude/approval-policy.ts \
  packages/hub/src/agents/claude/approval-policy.test.ts \
  packages/hub/src/wire.ts
git commit -m "fix(hub): approval-policy honours authoritative mode (auto-mode regression fix)"
```

---

## Task 4: Wire protocol — rename to `session.prompt-request`

**Goal:** Replace `session.confirmation` with `session.prompt-request` (mirroring claude's `PromptRequest`). Web `ConfirmationPanel` swap is in Task 8; here we change the protocol shape and keep the existing PreToolUse path working through it.

**Files:**
- Modify: `packages/shared/src/protocol.ts`
- Modify: `packages/hub/src/wire.ts`
- Modify: `packages/hub/src/ws/server.ts`
- Modify: `packages/hub/src/ws/connection.ts`
- Modify: `packages/debug-web/src/store.ts` (rename signal + interface for now; UI swap later)
- Modify: `packages/debug-web/src/ws-client.ts`
- Modify: `tests/e2e/run-e2e.mjs`

- [ ] **Step 1: Replace shared schemas**

In `packages/shared/src/protocol.ts`, **remove** `SessionConfirmationSchema`, `SessionConfirmationResolvedSchema`, `ConfirmationDecisionSchema`, `ConfirmationDecisionEnum`. Add the new ones:

```typescript
export const PromptOptionSchema = z.object({
  key:         z.string(),
  label:       z.string(),
  description: z.string().optional(),
  preview:     z.string().optional(),
  recommended: z.boolean().optional(),
});

export const PromptQuestionSchema = z.object({
  prompt:        z.string(),
  header:        z.string().optional(),
  multiSelect:   z.boolean(),
  allowFreeText: z.boolean(),
  options:       z.array(PromptOptionSchema),
});

export const SessionPromptRequestSchema = z.object({
  type:       z.literal('session.prompt-request'),
  sessionId:  z.string(),
  requestId:  z.string(),
  origin:     z.enum(['permission','ask-user-question','exit-plan-mode','enter-plan-mode']),
  toolName:   z.string(),
  toolUseId:  z.string().optional(),
  expiresAt:  z.number().int(),
  body:       z.string().optional(),
  questions:  z.array(PromptQuestionSchema),
});

export const SessionPromptRequestResolvedSchema = z.object({
  type:       z.literal('session.prompt-request.resolved'),
  sessionId:  z.string(),
  requestId:  z.string(),
  reason:     z.enum(['decided','timeout','cancelled-no-clients','session-ended']),
});

export const PromptResponseSchema = z.object({
  type:       z.literal('prompt-response'),
  sessionId:  z.string(),
  requestId:  z.string(),
  answers:    z.array(z.object({
    questionIndex:   z.number().int(),
    selectedKeys:    z.array(z.string()),
    freeText:        z.string().optional(),
    notes:           z.string().optional(),
  })),
});

export type SessionPromptRequest         = z.infer<typeof SessionPromptRequestSchema>;
export type SessionPromptRequestResolved = z.infer<typeof SessionPromptRequestResolvedSchema>;
export type PromptResponse               = z.infer<typeof PromptResponseSchema>;
export type PromptQuestion               = z.infer<typeof PromptQuestionSchema>;
export type PromptOption                 = z.infer<typeof PromptOptionSchema>;
```

Update the discriminated unions to swap entries:

```typescript
export const UpstreamMessageSchema = z.discriminatedUnion('type', [
  ClientIdentifySchema, SubscribeSchema, UnsubscribeSchema,
  InputTextSchema, InputActionSchema, ClientPongSchema,
  PromptResponseSchema,
]);

export const DownstreamMessageSchema = z.discriminatedUnion('type', [
  ServerHelloSchema, SessionListSchema, SessionAddedSchema, SessionRemovedSchema,
  SessionStateMsgSchema, SessionEventMsgSchema, SessionSummaryMsgSchema,
  SessionAttentionSchema, SessionRawSchema, ServerErrorSchema, ServerPingSchema,
  SessionPromptRequestSchema, SessionPromptRequestResolvedSchema,
]);
```

- [ ] **Step 2: Update WS capability map**

In `packages/hub/src/ws/server.ts`, replace the relevant case branches in `capabilityRequiredFor`:

```typescript
case 'session.prompt-request':
case 'session.prompt-request.resolved': return 'actions';
```

(Remove the `session.confirmation` cases.)

- [ ] **Step 3: Update connection.ts upstream handling**

In `packages/hub/src/ws/connection.ts`, **replace** the `confirmation.decision` branch with:

```typescript
if (msg.type === 'prompt-response') {
  const ok = deps.onPromptResponse?.(msg.sessionId, msg.requestId, msg.answers) ?? false;
  if (!ok) state.ws.send(JSON.stringify({ type: 'server.error', code: 'prompt-stale', message: 'no pending prompt-request for that requestId' }));
  return;
}
```

In the `WsServerDeps` interface (`ws/server.ts`), replace `onConfirmationDecision` with:

```typescript
onPromptResponse?: (sessionId: string, requestId: string, answers: import('@sesshin/shared').PromptResponse['answers']) => boolean;
```

- [ ] **Step 4: Refactor `wire.ts` to use new shapes**

In `packages/hub/src/wire.ts`, the existing PreToolUse callback constructs a `session.confirmation` message. Replace it with a single-question permission-style `session.prompt-request` (Task 5 will replace this whole synthesis with handler dispatch — for now, port it minimally):

Replace the `wsRef?.broadcast({ type: 'session.confirmation', ... })` and `onExpire` broadcast blocks with:

```typescript
const synthQuestions = [{
  prompt: `Run ${tool}?`,
  header: tool.slice(0, 12),
  multiSelect: false,
  allowFreeText: false,
  options: [
    { key: 'allow', label: 'Yes' },
    { key: 'deny',  label: 'No' },
    { key: 'ask',   label: 'Ask on laptop' },
  ],
}];

wsRef?.broadcast({
  type: 'session.prompt-request',
  sessionId: env.sessionId,
  requestId: request.requestId,
  origin: 'permission',
  toolName: tool,
  ...(toolUseId !== undefined ? { toolUseId } : {}),
  expiresAt: request.expiresAt,
  body: '```json\n' + JSON.stringify(toolInput, null, 2) + '\n```',
  questions: synthQuestions,
});
```

And `onExpire`:

```typescript
onExpire: (a) => {
  wsRef?.broadcast({
    type: 'session.prompt-request.resolved',
    sessionId: a.sessionId, requestId: a.requestId, reason: 'timeout',
  });
},
```

Replace the `onConfirmationDecision` callback in the WS server config with:

```typescript
onPromptResponse: (sessionId, requestId, answers) => {
  const key = answers[0]?.selectedKeys[0];
  let decision: 'allow' | 'deny' | 'ask' = 'ask';
  if (key === 'allow') decision = 'allow';
  else if (key === 'deny') decision = 'deny';
  const reason = answers[0]?.freeText;
  const ok = approvals.decide(requestId, { decision, ...(reason !== undefined ? { reason } : {}) });
  if (ok) {
    ws.broadcast({
      type: 'session.prompt-request.resolved',
      sessionId, requestId, reason: 'decided',
    });
  }
  return ok;
},
```

Add cancel handler in `cancelForSession` callback in registry-removed handler — broadcast `reason: 'session-ended'`. (We already call `approvals.cancelForSession` there; just add the broadcast.) Replace the existing `registry.on('session-removed', …)` block with:

```typescript
registry.on('session-removed', (id) => {
  for (const a of approvals.pendingForSession(id)) {
    wsRef?.broadcast({
      type: 'session.prompt-request.resolved',
      sessionId: id, requestId: a.requestId, reason: 'session-ended',
    });
  }
  approvals.cancelForSession(id);
});
```

- [ ] **Step 5: Update debug-web store + ws-client**

In `packages/debug-web/src/store.ts`, rename `confirmationsBySession` → `promptRequestsBySession`, `addConfirmation` → `addPromptRequest`, `removeConfirmation` → `removePromptRequest`, and the type:

```typescript
export interface PendingPromptRequest {
  sessionId: string;
  requestId: string;
  origin: 'permission' | 'ask-user-question' | 'exit-plan-mode' | 'enter-plan-mode';
  toolName: string;
  toolUseId?: string;
  body?: string;
  questions: Array<{
    prompt: string;
    header?: string;
    multiSelect: boolean;
    allowFreeText: boolean;
    options: Array<{ key: string; label: string; description?: string; preview?: string; recommended?: boolean }>;
  }>;
  expiresAt: number;
}

export const promptRequestsBySession = signal<Record<string, PendingPromptRequest[]>>({});
export function addPromptRequest(c: PendingPromptRequest): void {
  const cur = promptRequestsBySession.value[c.sessionId] ?? [];
  if (cur.some((x) => x.requestId === c.requestId)) return;
  promptRequestsBySession.value = { ...promptRequestsBySession.value, [c.sessionId]: [...cur, c] };
}
export function removePromptRequest(sessionId: string, requestId: string): void {
  const cur = promptRequestsBySession.value[sessionId] ?? [];
  const next = cur.filter((x) => x.requestId !== requestId);
  if (next.length === cur.length) return;
  promptRequestsBySession.value = { ...promptRequestsBySession.value, [sessionId]: next };
}
```

In `packages/debug-web/src/ws-client.ts`, replace `sendConfirmation` with `sendPromptResponse`:

```typescript
sendPromptResponse(sessionId: string, requestId: string, answers: PromptResponseAnswer[]): void {
  ws?.send(JSON.stringify({ type: 'prompt-response', sessionId, requestId, answers }));
}
```

Define `PromptResponseAnswer`:
```typescript
export interface PromptResponseAnswer {
  questionIndex: number;
  selectedKeys: string[];
  freeText?: string;
  notes?: string;
}
```

Replace the message handlers:

```typescript
case 'session.prompt-request':
  addPromptRequest({
    sessionId: m.sessionId, requestId: m.requestId,
    origin: m.origin, toolName: m.toolName, toolUseId: m.toolUseId,
    body: m.body, questions: m.questions, expiresAt: m.expiresAt,
  }); return;
case 'session.prompt-request.resolved':
  removePromptRequest(m.sessionId, m.requestId); return;
```

(Remove the old `session.confirmation` cases.)

The existing `ConfirmationPanel.tsx` reads `confirmationsBySession` — leave it temporarily broken; Task 8 replaces it. In `SessionDetail.tsx`, comment out the `<ConfirmationPanel />` line for now, OR make it a no-op stub that reads the new signal but doesn't render. Pragmatic: comment out.

```tsx
// import { ConfirmationPanel } from './ConfirmationPanel.js';   // replaced in Task 8
// <ConfirmationPanel ws={ws} sessionId={s.id} />               // replaced in Task 8
```

- [ ] **Step 6: Update e2e harness**

In `tests/e2e/run-e2e.mjs`, replace the message handler block:

```javascript
ws.on('message', (m) => {
  const msg = JSON.parse(m.toString());
  if (msg.type === 'session.event')   got.events.push(msg);
  if (msg.type === 'session.summary') got.summary = true;
  if (msg.type === 'session.state')   got.state = msg.state;
  if (msg.type === 'session.prompt-request') {
    got.confirmations.push(msg);
    ws.send(JSON.stringify({
      type: 'prompt-response',
      sessionId: msg.sessionId, requestId: msg.requestId,
      answers: [{ questionIndex: 0, selectedKeys: ['allow'], freeText: 'e2e: auto-approve' }],
    }));
  }
  if (msg.type === 'session.prompt-request.resolved') got.confirmationResolved += 1;
});
```

- [ ] **Step 7: Build & test**

```bash
pnpm build
pnpm test && pnpm e2e
```

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/protocol.ts \
  packages/hub/src/wire.ts packages/hub/src/ws/server.ts packages/hub/src/ws/connection.ts \
  packages/debug-web/src/store.ts packages/debug-web/src/ws-client.ts \
  packages/debug-web/src/components/SessionDetail.tsx \
  tests/e2e/run-e2e.mjs
git commit -m "feat(hub,web): rename session.confirmation → session.prompt-request (PromptRequest shape)"
```

---

## Task 5: Tool interaction handler registry

**Goal:** Per-tool handlers translate PreToolUse `tool_name`/`tool_input` into wire-uniform questions and translate user answers back into hook decisions. Replaces the synthesised single-question rendering in Task 4.

**Files:**
- Create: `packages/hub/src/agents/claude/tool-handlers/types.ts`
- Create: `packages/hub/src/agents/claude/tool-handlers/registry.ts` (+test)
- Create: `packages/hub/src/agents/claude/tool-handlers/bash.ts` (+test)
- Create: `packages/hub/src/agents/claude/tool-handlers/file-edit.ts` (+test)
- Create: `packages/hub/src/agents/claude/tool-handlers/web-fetch.ts` (+test)
- Create: `packages/hub/src/agents/claude/tool-handlers/ask-user-question.ts` (+test)
- Create: `packages/hub/src/agents/claude/tool-handlers/exit-plan-mode.ts` (+test)
- Create: `packages/hub/src/agents/claude/tool-handlers/catch-all.ts` (+test)
- Modify: `packages/hub/src/wire.ts`

- [ ] **Step 1: Define types**

Create `packages/hub/src/agents/claude/tool-handlers/types.ts`:

```typescript
import type { PermissionMode, PromptQuestion } from '@sesshin/shared';

export interface HandlerCtx {
  permissionMode: PermissionMode;
  cwd: string;
  sessionAllowList: string[];
}

export interface PromptAnswer {
  questionIndex: number;
  selectedKeys: string[];
  freeText?: string;
  notes?: string;
}

export interface RenderOutput {
  body?: string;
  questions: PromptQuestion[];
  origin?: 'permission' | 'ask-user-question' | 'exit-plan-mode' | 'enter-plan-mode';
}

export type HookDecision =
  | { kind: 'passthrough' }
  | { kind: 'allow';  updatedInput?: Record<string, unknown>; additionalContext?: string;
      sessionAllowAdd?: string }
  | { kind: 'deny';   reason?: string;     additionalContext?: string }
  | { kind: 'ask';    reason?: string };

export interface ToolHandler {
  toolName: string;
  render(input: Record<string, unknown>, ctx: HandlerCtx): RenderOutput;
  decide(answers: PromptAnswer[], input: Record<string, unknown>, ctx: HandlerCtx): HookDecision;
}
```

- [ ] **Step 2: Test the registry dispatch**

Create `packages/hub/src/agents/claude/tool-handlers/registry.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { getHandler } from './registry.js';

describe('tool-handler registry', () => {
  it('returns the Bash handler for tool_name="Bash"', () => {
    expect(getHandler('Bash').toolName).toBe('Bash');
  });
  it('returns the file-edit handler for Edit/Write/MultiEdit/NotebookEdit', () => {
    for (const t of ['Edit','Write','MultiEdit','NotebookEdit']) {
      expect(getHandler(t).toolName).toBe('FileEdit');
    }
  });
  it('returns catch-all for unknown tools', () => {
    expect(getHandler('mcp__custom__doStuff').toolName).toBe('CatchAll');
  });
});
```

- [ ] **Step 3: Run; FAIL**

```bash
pnpm --filter @sesshin/hub test -- tool-handlers/registry
```

- [ ] **Step 4: Implement registry**

Create `packages/hub/src/agents/claude/tool-handlers/registry.ts`:

```typescript
import type { ToolHandler } from './types.js';
import { bashHandler } from './bash.js';
import { fileEditHandler } from './file-edit.js';
import { webFetchHandler } from './web-fetch.js';
import { askUserQuestionHandler } from './ask-user-question.js';
import { exitPlanModeHandler } from './exit-plan-mode.js';
import { catchAllHandler } from './catch-all.js';

const MAP: Record<string, ToolHandler> = {
  Bash:                 bashHandler,
  PowerShell:           bashHandler,
  Edit:                 fileEditHandler,
  Write:                fileEditHandler,
  MultiEdit:            fileEditHandler,
  NotebookEdit:         fileEditHandler,
  WebFetch:             webFetchHandler,
  AskUserQuestion:      askUserQuestionHandler,
  ExitPlanMode:         exitPlanModeHandler,
};

export function getHandler(toolName: string): ToolHandler {
  return MAP[toolName] ?? catchAllHandler;
}
```

- [ ] **Step 5: Implement Bash handler — test first**

Create `packages/hub/src/agents/claude/tool-handlers/bash.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { bashHandler } from './bash.js';

const ctx = { permissionMode: 'default' as const, cwd: '/x', sessionAllowList: [] };

describe('bashHandler', () => {
  it('renders the command in a fenced bash block + 3 options', () => {
    const out = bashHandler.render({ command: 'git log --oneline' }, ctx);
    expect(out.origin).toBe('permission');
    expect(out.body).toContain('```bash\ngit log --oneline\n```');
    expect(out.questions).toHaveLength(1);
    const opts = out.questions[0]!.options.map(o => o.key);
    expect(opts).toEqual(['yes', 'yes-prefix', 'no']);
  });

  it('decide(yes) → allow', () => {
    const d = bashHandler.decide([{ questionIndex: 0, selectedKeys: ['yes'] }], { command: 'ls' }, ctx);
    expect(d).toEqual({ kind: 'allow' });
  });

  it('decide(no, freeText) → deny + additionalContext', () => {
    const d = bashHandler.decide(
      [{ questionIndex: 0, selectedKeys: ['no'], freeText: 'use grep instead' }],
      { command: 'ls' }, ctx,
    );
    expect(d).toEqual({ kind: 'deny', additionalContext: 'use grep instead' });
  });

  it('decide(yes-prefix, freeText) → allow + sessionAllowAdd', () => {
    const d = bashHandler.decide(
      [{ questionIndex: 0, selectedKeys: ['yes-prefix'], freeText: 'npm run:*' }],
      { command: 'npm run build' }, ctx,
    );
    expect(d).toMatchObject({ kind: 'allow', sessionAllowAdd: 'Bash(npm run:*)' });
  });

  it('decide(yes-prefix, no freeText) → allow + heuristic prefix from command', () => {
    const d = bashHandler.decide(
      [{ questionIndex: 0, selectedKeys: ['yes-prefix'] }],
      { command: 'git log --oneline' }, ctx,
    );
    expect(d).toMatchObject({ kind: 'allow', sessionAllowAdd: 'Bash(git log:*)' });
  });
});
```

- [ ] **Step 6: Run; FAIL**

```bash
pnpm --filter @sesshin/hub test -- tool-handlers/bash
```

- [ ] **Step 7: Implement Bash handler**

Create `packages/hub/src/agents/claude/tool-handlers/bash.ts`:

```typescript
import type { ToolHandler, RenderOutput, HookDecision, HandlerCtx, PromptAnswer } from './types.js';

function heuristicPrefix(command: string): string {
  // Take the first two words as the prefix, default to first word.
  const tokens = command.trim().split(/\s+/);
  const prefix = tokens.slice(0, Math.min(2, tokens.length)).join(' ');
  return `${prefix}:*`;
}

export const bashHandler: ToolHandler = {
  toolName: 'Bash',

  render(input: Record<string, unknown>): RenderOutput {
    const command = typeof input['command'] === 'string' ? input['command'] : '';
    return {
      origin: 'permission',
      body: '```bash\n' + command + '\n```',
      questions: [{
        prompt: 'Run this command?',
        header: 'Bash',
        multiSelect: false,
        allowFreeText: true,
        options: [
          { key: 'yes',        label: 'Yes' },
          { key: 'yes-prefix', label: 'Yes, don’t ask again for', description: 'Pattern; sesshin remembers for this session.' },
          { key: 'no',         label: 'No' },
        ],
      }],
    };
  },

  decide(answers: PromptAnswer[], input: Record<string, unknown>, _ctx: HandlerCtx): HookDecision {
    const a = answers[0];
    const key = a?.selectedKeys[0];
    if (key === 'yes') {
      return a?.freeText
        ? { kind: 'allow', additionalContext: a.freeText }
        : { kind: 'allow' };
    }
    if (key === 'yes-prefix') {
      const command = typeof input['command'] === 'string' ? input['command'] : '';
      const prefix = (a?.freeText && a.freeText.length > 0) ? a.freeText : heuristicPrefix(command);
      return { kind: 'allow', sessionAllowAdd: `Bash(${prefix})` };
    }
    if (key === 'no') {
      return a?.freeText
        ? { kind: 'deny', additionalContext: a.freeText }
        : { kind: 'deny' };
    }
    return { kind: 'ask' };
  },
};
```

- [ ] **Step 8: Run; PASS**

```bash
pnpm --filter @sesshin/hub test -- tool-handlers/bash
```

- [ ] **Step 9: Implement file-edit handler — test first**

Create `packages/hub/src/agents/claude/tool-handlers/file-edit.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { fileEditHandler } from './file-edit.js';

const ctx = { permissionMode: 'default' as const, cwd: '/proj', sessionAllowList: [] };

describe('fileEditHandler', () => {
  it('renders body with file_path + 3 options', () => {
    const out = fileEditHandler.render({ file_path: '/tmp/a.md', content: 'hello' }, ctx);
    expect(out.origin).toBe('permission');
    expect(out.body).toContain('/tmp/a.md');
    const keys = out.questions[0]!.options.map(o => o.key);
    expect(keys).toEqual(['yes', 'yes-session-scope', 'no']);
  });

  it('yes-session-scope adds dir glob to allow list', () => {
    const d = fileEditHandler.decide(
      [{ questionIndex: 0, selectedKeys: ['yes-session-scope'] }],
      { file_path: '/proj/src/foo.ts' }, ctx,
    );
    expect(d).toMatchObject({ kind: 'allow', sessionAllowAdd: 'Edit(/proj/src/*)' });
  });

  it('no with freeText becomes deny + additionalContext', () => {
    const d = fileEditHandler.decide(
      [{ questionIndex: 0, selectedKeys: ['no'], freeText: 'edit a different file' }],
      { file_path: '/proj/x.ts' }, ctx,
    );
    expect(d).toEqual({ kind: 'deny', additionalContext: 'edit a different file' });
  });
});
```

- [ ] **Step 10: Run; FAIL → Implement**

```bash
pnpm --filter @sesshin/hub test -- tool-handlers/file-edit
```

Create `packages/hub/src/agents/claude/tool-handlers/file-edit.ts`:

```typescript
import { dirname } from 'node:path';
import type { ToolHandler, RenderOutput, HookDecision, HandlerCtx, PromptAnswer } from './types.js';

export const fileEditHandler: ToolHandler = {
  toolName: 'FileEdit',

  render(input: Record<string, unknown>): RenderOutput {
    const filePath = typeof input['file_path'] === 'string' ? input['file_path'] : '?';
    const preview = previewBody(input);
    return {
      origin: 'permission',
      body: `**path:** \`${filePath}\`\n\n${preview}`,
      questions: [{
        prompt: 'Apply this change?',
        header: 'File',
        multiSelect: false,
        allowFreeText: true,
        options: [
          { key: 'yes',               label: 'Yes' },
          { key: 'yes-session-scope', label: 'Yes, allow all edits in this directory this session', description: 'Sesshin-side allow rule for the session.' },
          { key: 'no',                label: 'No' },
        ],
      }],
    };
  },

  decide(answers: PromptAnswer[], input: Record<string, unknown>): HookDecision {
    const a = answers[0];
    const key = a?.selectedKeys[0];
    const filePath = typeof input['file_path'] === 'string' ? input['file_path'] : '';
    if (key === 'yes') {
      return a?.freeText ? { kind: 'allow', additionalContext: a.freeText } : { kind: 'allow' };
    }
    if (key === 'yes-session-scope') {
      const dir = filePath ? dirname(filePath) : '';
      return { kind: 'allow', sessionAllowAdd: `Edit(${dir}/*)` };
    }
    if (key === 'no') {
      return a?.freeText ? { kind: 'deny', additionalContext: a.freeText } : { kind: 'deny' };
    }
    return { kind: 'ask' };
  },
};

function previewBody(input: Record<string, unknown>): string {
  // Best-effort preview for Edit/Write/MultiEdit/NotebookEdit
  if (typeof input['content'] === 'string') {
    const c = input['content'];
    return '```\n' + (c.length > 800 ? c.slice(0, 800) + '\n…(truncated)' : c) + '\n```';
  }
  if (typeof input['old_string'] === 'string' && typeof input['new_string'] === 'string') {
    return '```diff\n- ' + input['old_string'] + '\n+ ' + input['new_string'] + '\n```';
  }
  return '```json\n' + JSON.stringify(input, null, 2) + '\n```';
}
```

- [ ] **Step 11: Run; PASS**

```bash
pnpm --filter @sesshin/hub test -- tool-handlers/file-edit
```

- [ ] **Step 12: Implement web-fetch handler**

Create `packages/hub/src/agents/claude/tool-handlers/web-fetch.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { webFetchHandler } from './web-fetch.js';

const ctx = { permissionMode: 'default' as const, cwd: '/x', sessionAllowList: [] };

describe('webFetchHandler', () => {
  it('renders URL + host-scoped option', () => {
    const out = webFetchHandler.render({ url: 'https://example.com/api/x' }, ctx);
    expect(out.body).toContain('https://example.com/api/x');
    const keys = out.questions[0]!.options.map(o => o.key);
    expect(keys).toEqual(['yes', 'yes-host', 'no']);
  });
  it('yes-host extracts host', () => {
    const d = webFetchHandler.decide(
      [{ questionIndex: 0, selectedKeys: ['yes-host'] }],
      { url: 'https://example.com/api/x' }, ctx,
    );
    expect(d).toMatchObject({ kind: 'allow', sessionAllowAdd: 'WebFetch(https://example.com/*)' });
  });
});
```

Create `packages/hub/src/agents/claude/tool-handlers/web-fetch.ts`:

```typescript
import type { ToolHandler, RenderOutput, HookDecision, HandlerCtx, PromptAnswer } from './types.js';

export const webFetchHandler: ToolHandler = {
  toolName: 'WebFetch',
  render(input: Record<string, unknown>): RenderOutput {
    const url = typeof input['url'] === 'string' ? input['url'] : '?';
    return {
      origin: 'permission',
      body: `**url:** ${url}`,
      questions: [{
        prompt: 'Fetch this URL?',
        header: 'WebFetch',
        multiSelect: false, allowFreeText: true,
        options: [
          { key: 'yes',       label: 'Yes' },
          { key: 'yes-host',  label: 'Yes, allow all fetches to this host this session' },
          { key: 'no',        label: 'No' },
        ],
      }],
    };
  },
  decide(answers: PromptAnswer[], input: Record<string, unknown>, _ctx: HandlerCtx): HookDecision {
    const a = answers[0];
    const key = a?.selectedKeys[0];
    const url = typeof input['url'] === 'string' ? input['url'] : '';
    if (key === 'yes')  return a?.freeText ? { kind: 'allow', additionalContext: a.freeText } : { kind: 'allow' };
    if (key === 'yes-host') {
      try {
        const u = new URL(url);
        return { kind: 'allow', sessionAllowAdd: `WebFetch(${u.protocol}//${u.host}/*)` };
      } catch {
        return { kind: 'allow' };
      }
    }
    if (key === 'no')   return a?.freeText ? { kind: 'deny', additionalContext: a.freeText } : { kind: 'deny' };
    return { kind: 'ask' };
  },
};
```

Run: `pnpm --filter @sesshin/hub test -- tool-handlers/web-fetch` → PASS.

- [ ] **Step 13: Implement ask-user-question handler — test first**

Create `packages/hub/src/agents/claude/tool-handlers/ask-user-question.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { askUserQuestionHandler } from './ask-user-question.js';

const ctx = { permissionMode: 'default' as const, cwd: '/x', sessionAllowList: [] };

describe('askUserQuestionHandler', () => {
  const input = {
    questions: [{
      question: 'Which library?',
      header: 'Library',
      multiSelect: false,
      options: [
        { label: 'date-fns', description: 'Modular' },
        { label: 'moment',   description: 'Mature, deprecated' },
      ],
    }],
  };

  it('forwards the question shape with origin=ask-user-question', () => {
    const out = askUserQuestionHandler.render(input, ctx);
    expect(out.origin).toBe('ask-user-question');
    expect(out.questions[0]!.prompt).toBe('Which library?');
    expect(out.questions[0]!.allowFreeText).toBe(true);
    expect(out.questions[0]!.options.map(o => o.label)).toEqual(['date-fns', 'moment']);
  });

  it('strips "(Recommended)" suffix and sets recommended flag', () => {
    const out = askUserQuestionHandler.render({
      questions: [{
        question: 'Q', header: 'H', multiSelect: false,
        options: [{ label: 'opt1 (Recommended)', description: 'd' }, { label: 'opt2', description: 'd' }],
      }],
    }, ctx);
    expect(out.questions[0]!.options[0]).toMatchObject({ label: 'opt1', recommended: true });
    expect(out.questions[0]!.options[1]!.recommended).toBeUndefined();
  });

  it('decide produces updatedInput.answers keyed by question text', () => {
    const out = askUserQuestionHandler.render(input, ctx);
    const dateFnsKey = out.questions[0]!.options[0]!.key;
    const d = askUserQuestionHandler.decide(
      [{ questionIndex: 0, selectedKeys: [dateFnsKey] }], input, ctx,
    );
    expect(d).toMatchObject({
      kind: 'allow',
      updatedInput: { questions: input.questions, answers: { 'Which library?': 'date-fns' } },
    });
  });

  it('decide handles free-text Other', () => {
    const d = askUserQuestionHandler.decide(
      [{ questionIndex: 0, selectedKeys: [], freeText: 'something else' }], input, ctx,
    );
    expect(d).toMatchObject({
      kind: 'allow',
      updatedInput: { answers: { 'Which library?': 'something else' } },
    });
  });

  it('decide handles multiSelect comma-joining', () => {
    const ms = {
      questions: [{
        question: 'Tags?', header: 'T', multiSelect: true,
        options: [{ label: 'a', description: '' }, { label: 'b', description: '' }, { label: 'c', description: '' }],
      }],
    };
    const out = askUserQuestionHandler.render(ms, ctx);
    const ka = out.questions[0]!.options[0]!.key;
    const kc = out.questions[0]!.options[2]!.key;
    const d = askUserQuestionHandler.decide(
      [{ questionIndex: 0, selectedKeys: [ka, kc] }], ms, ctx,
    );
    expect(d.kind).toBe('allow');
    if (d.kind === 'allow') expect(d.updatedInput!['answers']).toEqual({ 'Tags?': 'a, c' });
  });
});
```

- [ ] **Step 14: Implement**

Create `packages/hub/src/agents/claude/tool-handlers/ask-user-question.ts`:

```typescript
import { createHash } from 'node:crypto';
import type { ToolHandler, RenderOutput, HookDecision, HandlerCtx, PromptAnswer } from './types.js';

interface ClaudeQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: Array<{ label: string; description: string; preview?: string }>;
}

function keyOf(label: string): string {
  return 'opt-' + createHash('sha256').update(label).digest('hex').slice(0, 8);
}

const RECOMMENDED_RE = /\s+\(Recommended\)$/;

export const askUserQuestionHandler: ToolHandler = {
  toolName: 'AskUserQuestion',

  render(input: Record<string, unknown>): RenderOutput {
    const questions = (input['questions'] as ClaudeQuestion[]) ?? [];
    return {
      origin: 'ask-user-question',
      questions: questions.map(q => ({
        prompt: q.question,
        ...(q.header !== undefined ? { header: q.header } : {}),
        multiSelect: !!q.multiSelect,
        allowFreeText: true,    // claude implicitly adds Other
        options: q.options.map(o => {
          const recommended = RECOMMENDED_RE.test(o.label);
          return {
            key: keyOf(o.label),
            label: recommended ? o.label.replace(RECOMMENDED_RE, '') : o.label,
            ...(o.description ? { description: o.description } : {}),
            ...(o.preview     ? { preview: o.preview }         : {}),
            ...(recommended   ? { recommended: true }          : {}),
          };
        }),
      })),
    };
  },

  decide(answers: PromptAnswer[], input: Record<string, unknown>, _ctx: HandlerCtx): HookDecision {
    const questions = (input['questions'] as ClaudeQuestion[]) ?? [];
    const answersOut: Record<string, string> = {};
    const annotations: Record<string, { preview?: string; notes?: string }> = {};

    for (let i = 0; i < questions.length; i += 1) {
      const q = questions[i]!;
      const a = answers.find(x => x.questionIndex === i);
      if (!a) continue;
      const labelByKey = new Map<string, string>();
      const previewByLabel = new Map<string, string | undefined>();
      for (const o of q.options) {
        labelByKey.set(keyOf(o.label), o.label.replace(RECOMMENDED_RE, ''));
        previewByLabel.set(o.label.replace(RECOMMENDED_RE, ''), o.preview);
      }
      const labels: string[] = [];
      for (const k of a.selectedKeys) {
        const l = labelByKey.get(k);
        if (l) labels.push(l);
      }
      if (a.freeText) labels.push(a.freeText);
      const value = labels.join(', ');
      if (value) answersOut[q.question] = value;

      // Forward preview for first-selected option (single-select use)
      if (!q.multiSelect && labels[0]) {
        const p = previewByLabel.get(labels[0]);
        if (p) annotations[q.question] = { ...(annotations[q.question] ?? {}), preview: p };
      }
      if (a.notes) annotations[q.question] = { ...(annotations[q.question] ?? {}), notes: a.notes };
    }

    const updatedInput: Record<string, unknown> = { ...input, answers: answersOut };
    if (Object.keys(annotations).length > 0) updatedInput['annotations'] = annotations;
    return { kind: 'allow', updatedInput };
  },
};
```

Run: `pnpm --filter @sesshin/hub test -- ask-user-question` → PASS.

- [ ] **Step 15: Implement exit-plan-mode handler**

Create `packages/hub/src/agents/claude/tool-handlers/exit-plan-mode.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { exitPlanModeHandler } from './exit-plan-mode.js';

const ctx = { permissionMode: 'plan' as const, cwd: '/x', sessionAllowList: [] };

describe('exitPlanModeHandler', () => {
  it('renders plan body + 3 options', () => {
    const out = exitPlanModeHandler.render({ plan: '# Plan\n\nDo X then Y' }, ctx);
    expect(out.origin).toBe('exit-plan-mode');
    expect(out.body).toBe('# Plan\n\nDo X then Y');
    const keys = out.questions[0]!.options.map(o => o.key);
    expect(keys).toEqual(['yes-default', 'yes-accept-edits', 'no']);
  });
  it('yes-default → allow', () => {
    expect(exitPlanModeHandler.decide([{ questionIndex: 0, selectedKeys: ['yes-default'] }], {}, ctx))
      .toEqual({ kind: 'allow' });
  });
  it('no with feedback → deny + additionalContext', () => {
    const d = exitPlanModeHandler.decide(
      [{ questionIndex: 0, selectedKeys: ['no'], freeText: 'change Y to Z first' }], {}, ctx);
    expect(d).toEqual({ kind: 'deny', additionalContext: 'change Y to Z first' });
  });
});
```

Create `packages/hub/src/agents/claude/tool-handlers/exit-plan-mode.ts`:

```typescript
import type { ToolHandler, RenderOutput, HookDecision, HandlerCtx, PromptAnswer } from './types.js';

export const exitPlanModeHandler: ToolHandler = {
  toolName: 'ExitPlanMode',
  render(input: Record<string, unknown>): RenderOutput {
    const plan = typeof input['plan'] === 'string' ? input['plan'] : '(empty)';
    return {
      origin: 'exit-plan-mode',
      body: plan,
      questions: [{
        prompt: 'Approve and execute this plan?',
        header: 'Plan',
        multiSelect: false,
        allowFreeText: true,
        options: [
          { key: 'yes-default',      label: 'Approve and execute' },
          { key: 'yes-accept-edits', label: 'Approve in acceptEdits mode',
            description: 'Sesshin remembers the preference; runtime mode unchanged' },
          { key: 'no',               label: 'Reject' },
        ],
      }],
    };
  },
  decide(answers: PromptAnswer[], _input: Record<string, unknown>, _ctx: HandlerCtx): HookDecision {
    const a = answers[0];
    const key = a?.selectedKeys[0];
    if (key === 'yes-default' || key === 'yes-accept-edits') return { kind: 'allow' };
    if (key === 'no') return a?.freeText ? { kind: 'deny', additionalContext: a.freeText } : { kind: 'deny' };
    return { kind: 'ask' };
  },
};
```

- [ ] **Step 16: Implement catch-all handler**

Create `packages/hub/src/agents/claude/tool-handlers/catch-all.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { catchAllHandler } from './catch-all.js';

const ctx = { permissionMode: 'default' as const, cwd: '/x', sessionAllowList: [] };

describe('catchAllHandler', () => {
  it('renders tool name + JSON-stringified input', () => {
    const out = catchAllHandler.render({ x: 1, y: 'hi' }, ctx);
    expect(out.body).toContain('"x": 1');
    const keys = out.questions[0]!.options.map(o => o.key);
    expect(keys).toEqual(['allow', 'allow-this-session', 'deny']);
  });
  it('allow-this-session adds Tool(json) entry', () => {
    const handler = catchAllHandler;
    const out = handler.render({ k: 'v' }, ctx);
    void out;
    const d = handler.decide(
      [{ questionIndex: 0, selectedKeys: ['allow-this-session'] }],
      { k: 'v' }, ctx,
    );
    expect(d.kind).toBe('allow');
    if (d.kind === 'allow') expect(d.sessionAllowAdd).toContain('"k":"v"');
  });
});
```

Create `packages/hub/src/agents/claude/tool-handlers/catch-all.ts`:

```typescript
import type { ToolHandler, RenderOutput, HookDecision, HandlerCtx, PromptAnswer } from './types.js';

let LAST_TOOL_NAME = '';   // set by registry; see Step 17

export const catchAllHandler: ToolHandler = {
  toolName: 'CatchAll',

  render(input: Record<string, unknown>): RenderOutput {
    return {
      origin: 'permission',
      body: '```json\n' + JSON.stringify(input, null, 2) + '\n```',
      questions: [{
        prompt: 'Allow this tool call?',
        header: LAST_TOOL_NAME.slice(0, 12),
        multiSelect: false,
        allowFreeText: true,
        options: [
          { key: 'allow',              label: 'Allow' },
          { key: 'allow-this-session', label: 'Allow this exact call this session' },
          { key: 'deny',               label: 'Deny' },
        ],
      }],
    };
  },

  decide(answers: PromptAnswer[], input: Record<string, unknown>, _ctx: HandlerCtx): HookDecision {
    const a = answers[0];
    const key = a?.selectedKeys[0];
    if (key === 'allow') return a?.freeText ? { kind: 'allow', additionalContext: a.freeText } : { kind: 'allow' };
    if (key === 'allow-this-session') {
      return { kind: 'allow', sessionAllowAdd: `${LAST_TOOL_NAME}(${JSON.stringify(input)})` };
    }
    if (key === 'deny') return a?.freeText ? { kind: 'deny', additionalContext: a.freeText } : { kind: 'deny' };
    return { kind: 'ask' };
  },
};

export function setCatchAllToolName(name: string): void { LAST_TOOL_NAME = name; }
```

> Note: the catch-all needs the actual tool name. The mutable `LAST_TOOL_NAME` is a per-call tracker set by the registry just before delegation; alternatives (passing it via render args) are cleaner but invasive across all handlers. Acceptable for v1.5.

- [ ] **Step 17: Wire dispatch into `wire.ts`**

Replace the synthesised question synthesis from Task 4 with handler dispatch. In `packages/hub/src/wire.ts`, replace the `onPreToolUseApproval` body with:

```typescript
onPreToolUseApproval: async (env) => {
  const session = registry.get(env.sessionId);
  const knownMode = session?.substate.permissionMode ?? null;
  if (!shouldGatePreToolUse(env.raw, knownMode, approvalGate)) return null;

  const tool = typeof env.raw['tool_name'] === 'string' ? env.raw['tool_name'] : 'unknown';
  const toolInput = (env.raw['tool_input'] as Record<string, unknown>) ?? {};
  const toolUseId = typeof env.raw['tool_use_id'] === 'string' ? env.raw['tool_use_id'] : undefined;

  setCatchAllToolName(tool);
  const handler = getHandler(tool);
  const rendered = handler.render(toolInput, {
    permissionMode: knownMode ?? 'default',
    cwd: session?.cwd ?? process.cwd(),
    sessionAllowList: session?.sessionAllowList ?? [],
  });

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

  // Park the answers + handler on the approval entry so onPromptResponse can resolve them.
  pendingHandlers.set(request.requestId, { handler, ctx: {
    permissionMode: knownMode ?? 'default',
    cwd: session?.cwd ?? process.cwd(),
    sessionAllowList: session?.sessionAllowList ?? [],
  }, toolInput });

  const out = await decision;
  registry.updateState(env.sessionId, 'running');
  return out;
},
```

Add at top of `wire.ts`:

```typescript
import { getHandler, setCatchAllToolName } from './agents/claude/tool-handlers/registry.js';
const pendingHandlers = new Map<string, {
  handler:   import('./agents/claude/tool-handlers/types.js').ToolHandler;
  ctx:       import('./agents/claude/tool-handlers/types.js').HandlerCtx;
  toolInput: Record<string, unknown>;
  tool:      string;   // actual claude tool name from env.raw — handler.toolName may be a meta-name (e.g. 'FileEdit')
}>();
```

In the `pendingHandlers.set(...)` call inside `onPreToolUseApproval`, include `tool`:

```typescript
pendingHandlers.set(request.requestId, { handler, ctx: { … }, toolInput, tool });
```

And `setCatchAllToolName` lives in `catch-all.ts` (Step 16) — re-export from registry: in `registry.ts` add `export { setCatchAllToolName } from './catch-all.js';`.

Replace the `onPromptResponse` callback to use handler.decide:

```typescript
onPromptResponse: (sessionId, requestId, answers) => {
  const slot = pendingHandlers.get(requestId);
  if (!slot) return false;
  pendingHandlers.delete(requestId);
  const decision = slot.handler.decide(answers, slot.toolInput, slot.ctx);

  let outcome: { decision: 'allow' | 'deny' | 'ask'; reason?: string };
  switch (decision.kind) {
    case 'passthrough':   outcome = { decision: 'ask', reason: 'sesshin: handler passthrough' }; break;
    case 'allow':         outcome = { decision: 'allow', ...(decision.additionalContext ? { reason: decision.additionalContext } : {}) }; break;
    case 'deny':          outcome = { decision: 'deny',  ...(decision.additionalContext ? { reason: decision.additionalContext } : decision.reason !== undefined ? { reason: decision.reason } : {}) }; break;
    case 'ask':           outcome = { decision: 'ask',   ...(decision.reason ? { reason: decision.reason } : {}) }; break;
  }

  if (decision.kind === 'allow' && decision.sessionAllowAdd) {
    const rec = registry.get(sessionId);
    if (rec) rec.sessionAllowList.push(decision.sessionAllowAdd);
  }

  // updatedInput for AskUserQuestion etc — pass through via the approval manager.
  // The current ApprovalManager only carries decision/reason; extend it minimally:
  if (decision.kind === 'allow' && decision.updatedInput) {
    pendingUpdatedInput.set(requestId, decision.updatedInput);
  }

  const ok = approvals.decide(requestId, outcome);
  if (ok) {
    ws.broadcast({
      type: 'session.prompt-request.resolved',
      sessionId, requestId, reason: 'decided',
    });
  }
  return ok;
},
```

Add at top of `wire.ts`:
```typescript
const pendingUpdatedInput = new Map<string, Record<string, unknown>>();
```

The REST handler that builds the JSON response to claude needs to use this. In `packages/hub/src/rest/server.ts`, the existing `ingestHook` builds `out` with `hookSpecificOutput`. Change the construction so `updatedInput` rides along when present. We need to plumb it from `wire.ts`'s map into the REST callback.

Easier: change `onPreToolUseApproval` return type to include `updatedInput?: Record<string, unknown>`. In `wire.ts`'s callback, after `await decision`, look up the map:

```typescript
const out = await decision;
registry.updateState(env.sessionId, 'running');
const ui = pendingUpdatedInput.get(request.requestId);
pendingUpdatedInput.delete(request.requestId);
return { ...out, ...(ui ? { updatedInput: ui } : {}) };
```

Then in `packages/hub/src/rest/server.ts`'s `ingestHook` block where we serialise:

```typescript
const out: any = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: outcome.decision,
    ...(outcome.reason !== undefined ? { permissionDecisionReason: outcome.reason } : {}),
    ...((outcome as any).updatedInput !== undefined ? { updatedInput: (outcome as any).updatedInput } : {}),
  },
};
```

Update the `onPreToolUseApproval` type in `RestServerDeps`:

```typescript
onPreToolUseApproval?: (envelope: { … }) => Promise<{
  decision: 'allow' | 'deny' | 'ask';
  reason?: string;
  updatedInput?: Record<string, unknown>;
} | null>;
```

- [ ] **Step 18: Run all tests + e2e**

```bash
pnpm test && pnpm e2e
```

The existing e2e PreToolUse path (Task 4 retained the `allow` answer) continues to work — handler dispatch produces the same `permissionDecision: allow` for `selectedKeys=['yes']` (Bash handler).

- [ ] **Step 19: Commit**

```bash
git add packages/hub/src/agents/claude/tool-handlers/ \
  packages/hub/src/wire.ts packages/hub/src/rest/server.ts
git commit -m "feat(hub): per-tool ToolInteractionHandler registry"
```

---

## Task 6: Permission rules port

**Goal:** Port claude's rule parser/formatter and matcher. `approval-policy` consults `sessionAllowList` ∪ `claudeAllowRules` and skips gating on a match.

**Files:**
- Create: `packages/hub/src/agents/claude/permission-rules.ts` (+test)
- Modify: `packages/hub/src/agents/claude/approval-policy.ts` (+test)
- Modify: `packages/hub/src/wire.ts`

- [ ] **Step 1: Test the parser/formatter round-trip**

Create `packages/hub/src/agents/claude/permission-rules.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseRuleString, formatRuleString, matchRule } from './permission-rules.js';

describe('parseRuleString', () => {
  it('parses bare tool name', () => {
    expect(parseRuleString('Bash')).toEqual({ toolName: 'Bash', ruleContent: null });
  });
  it('parses Tool(content)', () => {
    expect(parseRuleString('Bash(npm install)')).toEqual({ toolName: 'Bash', ruleContent: 'npm install' });
  });
  it('parses with prefix wildcard', () => {
    expect(parseRuleString('Bash(git log:*)')).toEqual({ toolName: 'Bash', ruleContent: 'git log:*' });
  });
  it('handles escaped parens in content', () => {
    expect(parseRuleString('Bash(python -c "print\\(1\\)")')).toEqual({
      toolName: 'Bash', ruleContent: 'python -c "print(1)"',
    });
  });
  it('returns null for malformed', () => {
    expect(parseRuleString('garbage(')).toBeNull();
  });
});

describe('formatRuleString', () => {
  it('formats with escaping', () => {
    expect(formatRuleString('Bash', 'python -c "print(1)"'))
      .toBe('Bash(python -c "print\\(1\\)")');
  });
  it('formats null content as bare name', () => {
    expect(formatRuleString('Bash', null)).toBe('Bash');
  });
});

describe('matchRule — Bash', () => {
  it('bare Bash matches all calls', () => {
    expect(matchRule('Bash', { command: 'rm -rf /' }, parseRuleString('Bash')!)).toBe(true);
  });
  it('exact match', () => {
    expect(matchRule('Bash', { command: 'npm install' }, parseRuleString('Bash(npm install)')!)).toBe(true);
    expect(matchRule('Bash', { command: 'npm uninstall' }, parseRuleString('Bash(npm install)')!)).toBe(false);
  });
  it('prefix wildcard', () => {
    const rule = parseRuleString('Bash(git log:*)')!;
    expect(matchRule('Bash', { command: 'git log --oneline' }, rule)).toBe(true);
    expect(matchRule('Bash', { command: 'git logout' }, rule)).toBe(false);
  });
});

describe('matchRule — file tools', () => {
  it('Edit dir glob', () => {
    const rule = parseRuleString('Edit(/proj/src/*)')!;
    expect(matchRule('Edit', { file_path: '/proj/src/a.ts' }, rule)).toBe(true);
    expect(matchRule('Edit', { file_path: '/proj/src/sub/b.ts' }, rule)).toBe(true);
    expect(matchRule('Edit', { file_path: '/proj/test.ts' }, rule)).toBe(false);
  });
});
```

- [ ] **Step 2: Implement parser/formatter**

Create `packages/hub/src/agents/claude/permission-rules.ts`:

```typescript
export interface ParsedRule { toolName: string; ruleContent: string | null }

const TOOL_RE = /^([A-Za-z_][A-Za-z0-9_]*)(?:\((.*)\))?$/s;

function unescape(s: string): string {
  return s.replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\\/g, '\\');
}
function escape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

export function parseRuleString(s: string): ParsedRule | null {
  const m = TOOL_RE.exec(s.trim());
  if (!m) return null;
  const toolName = m[1]!;
  const raw = m[2];
  return {
    toolName,
    ruleContent: raw === undefined ? null : unescape(raw),
  };
}

export function formatRuleString(toolName: string, content: string | null): string {
  return content === null ? toolName : `${toolName}(${escape(content)})`;
}

export function matchRule(
  toolName: string,
  toolInput: Record<string, unknown>,
  rule: ParsedRule,
): boolean {
  if (rule.toolName !== toolName) return false;
  if (rule.ruleContent === null) return true;     // bare tool name → matches all

  switch (toolName) {
    case 'Bash':
    case 'PowerShell': {
      const command = typeof toolInput['command'] === 'string' ? toolInput['command'] : '';
      const c = rule.ruleContent;
      if (c.endsWith(':*')) {
        return command.startsWith(c.slice(0, -2));
      }
      return command === c;
    }
    case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': {
      const fp = typeof toolInput['file_path'] === 'string' ? toolInput['file_path'] : '';
      const c = rule.ruleContent;
      if (c.endsWith('/*')) {
        const prefix = c.slice(0, -2);
        return fp === prefix || fp.startsWith(prefix + '/');
      }
      return fp === c;
    }
    case 'WebFetch': case 'WebSearch': {
      const url = typeof toolInput['url'] === 'string' ? toolInput['url']
                : typeof toolInput['query'] === 'string' ? toolInput['query']
                : '';
      const c = rule.ruleContent;
      if (c.endsWith('/*')) return url.startsWith(c.slice(0, -2));
      return url === c;
    }
    default: {
      // Catch-all: exact-string match on JSON.stringify(input)
      return JSON.stringify(toolInput) === rule.ruleContent;
    }
  }
}

export function ruleMatchesAny(
  toolName: string,
  toolInput: Record<string, unknown>,
  ruleStrings: readonly string[],
): boolean {
  for (const s of ruleStrings) {
    const r = parseRuleString(s);
    if (r && matchRule(toolName, toolInput, r)) return true;
  }
  return false;
}
```

Run: `pnpm --filter @sesshin/hub test -- permission-rules` → PASS.

- [ ] **Step 3: Wire into approval-policy**

Update `shouldGatePreToolUse` to consider the allow lists. Update test first:

In `packages/hub/src/agents/claude/approval-policy.test.ts`:

```typescript
it('does NOT gate when tool matches sessionAllowList', () => {
  expect(shouldGatePreToolUse(
    { permission_mode: 'default', tool_name: 'Bash', tool_input: { command: 'git log --oneline' } },
    'default', 'auto',
    { sessionAllowList: ['Bash(git log:*)'], claudeAllowRules: [] },
  )).toBe(false);
});
it('does NOT gate when tool matches claudeAllowRules', () => {
  expect(shouldGatePreToolUse(
    { permission_mode: 'default', tool_name: 'Bash', tool_input: { command: 'npm install' } },
    'default', 'auto',
    { sessionAllowList: [], claudeAllowRules: ['Bash(npm install)'] },
  )).toBe(false);
});
```

Update existing tests to pass the new fourth arg `{ sessionAllowList: [], claudeAllowRules: [] }` where omitted.

Update `approval-policy.ts`:

```typescript
import { ruleMatchesAny } from './permission-rules.js';

export interface AllowContext {
  sessionAllowList: readonly string[];
  claudeAllowRules: readonly string[];
}

export function shouldGatePreToolUse(
  raw: Record<string, unknown>,
  knownMode: PermissionMode | null,
  policy: ApprovalGatePolicy,
  allow: AllowContext = { sessionAllowList: [], claudeAllowRules: [] },
): boolean {
  if (policy === 'disabled') return false;
  if (policy === 'always')   return true;
  const mode: string =
    knownMode ??
    (typeof raw['permission_mode'] === 'string' ? raw['permission_mode'] : 'default');
  if (AUTO_EXECUTE_MODES.has(mode)) return false;
  if (mode === 'plan')              return false;
  const tool = typeof raw['tool_name'] === 'string' ? raw['tool_name'] : '';
  const toolInput = (raw['tool_input'] as Record<string, unknown>) ?? {};
  if (ruleMatchesAny(tool, toolInput, allow.sessionAllowList)) return false;
  if (ruleMatchesAny(tool, toolInput, allow.claudeAllowRules))  return false;
  return GATED_TOOLS.has(tool);
}
```

- [ ] **Step 4: Update wire.ts call site**

In `packages/hub/src/wire.ts`, modify the gate call:

```typescript
const session = registry.get(env.sessionId);
const knownMode = session?.substate.permissionMode ?? null;
if (!shouldGatePreToolUse(env.raw, knownMode, approvalGate, {
  sessionAllowList: session?.sessionAllowList ?? [],
  claudeAllowRules: session?.claudeAllowRules ?? [],
})) return null;
```

- [ ] **Step 5: Run full + e2e**

```bash
pnpm test && pnpm e2e
```

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/agents/claude/permission-rules.ts \
  packages/hub/src/agents/claude/permission-rules.test.ts \
  packages/hub/src/agents/claude/approval-policy.ts \
  packages/hub/src/agents/claude/approval-policy.test.ts \
  packages/hub/src/wire.ts
git commit -m "feat(hub): claude-style permission-rules parser/matcher; mirror permissions.allow"
```

---

## Task 7: Subscribed-client gating + last-disconnect handling

**Goal:** Hub tracks per-session connected-client set. `shouldGatePreToolUse` returns false when no `actions`-capable client subscribes. When the last client disconnects mid-approval, pending requests resolve as `'ask'` so the laptop TUI takes over.

**Files:**
- Modify: `packages/hub/src/ws/connection.ts`
- Modify: `packages/hub/src/ws/server.ts`
- Modify: `packages/hub/src/wire.ts`
- Modify: `packages/hub/src/approval-manager.ts`
- Modify: `packages/hub/src/approval-manager.test.ts`
- Modify: `packages/hub/src/agents/claude/approval-policy.ts`
- Modify: `packages/hub/src/agents/claude/approval-policy.test.ts`

- [ ] **Step 1: Add `cancelOnLastClientGone` to ApprovalManager**

In `packages/hub/src/approval-manager.test.ts`, add:

```typescript
it('cancelOnLastClientGone resolves all pending for a session as ask', async () => {
  const m = new ApprovalManager({ defaultTimeoutMs: 5000 });
  const a = m.open({ sessionId: 's1', tool: 'Bash', toolInput: {} });
  const b = m.open({ sessionId: 's2', tool: 'Edit', toolInput: {} });
  expect(m.cancelOnLastClientGone('s1')).toBe(1);
  await expect(a.decision).resolves.toMatchObject({ decision: 'ask' });
  expect(m.pendingForSession('s2')).toHaveLength(1);
  m.decide(b.request.requestId, { decision: 'allow' });
});
```

In `packages/hub/src/approval-manager.ts`, add:

```typescript
cancelOnLastClientGone(sessionId: string): number {
  return this.cancelForSession(sessionId, 'sesshin: last subscribed client disconnected');
}
```

(`cancelForSession` already exists; this is just an aliased semantics tag.)

Run: `pnpm --filter @sesshin/hub test -- approval-manager` → PASS.

- [ ] **Step 2: Add subscribed-client tracker to WS layer**

In `packages/hub/src/ws/server.ts`, the `WsServerInstance` interface — extend with helpers:

```typescript
export interface WsServerInstance {
  listen(port: number, host: string): Promise<void>;
  close(): Promise<void>;
  address(): AddressInfo;
  broadcast(msg: object): void;
  hasSubscribedActionsClient(sessionId: string): boolean;
}
```

Maintain a counter map. Inside `createWsServer`:

```typescript
const targets = new Map<WebSocket, BroadcastTarget>();
// new:
const actionsByCenter = new Map<string, number>();   // sessionId → count
function bumpActions(sessionId: string, delta: 1 | -1) {
  const cur = actionsByCenter.get(sessionId) ?? 0;
  const next = cur + delta;
  if (next <= 0) actionsByCenter.delete(sessionId);
  else actionsByCenter.set(sessionId, next);
  if (delta === -1 && next <= 0) deps.onLastActionsClientGone?.(sessionId);
}
```

Pass `bumpActions` down into `handleConnection` so it can call it on subscribe/unsubscribe/close.

Add to `WsServerDeps`:

```typescript
onLastActionsClientGone?: (sessionId: string) => void;
```

Return:
```typescript
hasSubscribedActionsClient: (sid) => (actionsByCenter.get(sid) ?? 0) > 0,
```

In `packages/hub/src/ws/connection.ts`, the `handleConnection` signature gains a `bumpActions` arg. When the client sends `subscribe`:

```typescript
if (msg.type === 'subscribe') {
  // Compute the diff between previous and new subscription set, ONLY for clients with `actions` cap.
  const hasActions = state.capabilities.has('actions');
  if (hasActions) {
    const prev = state.subscribedTo === 'all'
      ? new Set(deps.registry.list().map(s => s.id))
      : state.subscribedTo;
    const next = msg.sessions === 'all'
      ? new Set(deps.registry.list().map(s => s.id))
      : new Set(msg.sessions);
    for (const id of next) if (!prev.has(id)) bumpActions(id, 1);
    for (const id of prev) if (!next.has(id)) bumpActions(id, -1);
  }
  state.subscribedTo = msg.sessions === 'all' ? 'all' : new Set(msg.sessions);
  // …existing snapshot send…
}
```

On `ws.on('close')`:
```typescript
ws.on('close', () => {
  // …existing close handling…
  const hasActions = state.capabilities.has('actions');
  if (hasActions) {
    const cur = state.subscribedTo === 'all'
      ? deps.registry.list().map(s => s.id)
      : Array.from(state.subscribedTo);
    for (const id of cur) bumpActions(id, -1);
  }
});
```

(Track `bumpActions` invocations; `clearTimeout(identifyTimeout)` etc. remain.)

- [ ] **Step 3: Wire `onLastActionsClientGone` in wire.ts**

In `packages/hub/src/wire.ts`, the `createWsServer` call grows:

```typescript
const ws = createWsServer({
  registry, bus: dedupedBus, tap, staticDir,
  onInput: …,
  onPromptResponse: …,
  onLastActionsClientGone: (sessionId) => {
    const cancelled = approvals.cancelOnLastClientGone(sessionId);
    if (cancelled > 0) {
      log.info({ sessionId, cancelled }, 'released pending approvals: last actions-client gone');
      // Broadcast the resolved messages so any reconnecting client sees them disappear:
      // (no-op since the only client that would have cared just left — but harmless and consistent)
    }
  },
});
```

- [ ] **Step 4: Use it in approval policy**

Update `shouldGatePreToolUse` signature to include `hasSubscribedActionsClient` boolean:

```typescript
export function shouldGatePreToolUse(
  raw: Record<string, unknown>,
  knownMode: PermissionMode | null,
  policy: ApprovalGatePolicy,
  allow: AllowContext,
  hasSubscribedClient: boolean,
): boolean {
  if (policy === 'disabled') return false;
  if (policy === 'always')   return true;
  // policy === 'auto'
  const mode: string =
    knownMode ??
    (typeof raw['permission_mode'] === 'string' ? raw['permission_mode'] : 'default');
  if (AUTO_EXECUTE_MODES.has(mode)) return false;
  if (mode === 'plan')              return false;
  if (!hasSubscribedClient)         return false;
  const tool = typeof raw['tool_name'] === 'string' ? raw['tool_name'] : '';
  const toolInput = (raw['tool_input'] as Record<string, unknown>) ?? {};
  if (ruleMatchesAny(tool, toolInput, allow.sessionAllowList)) return false;
  if (ruleMatchesAny(tool, toolInput, allow.claudeAllowRules))  return false;
  return GATED_TOOLS.has(tool);
}
```

In tests, add:

```typescript
it('does NOT gate when no client subscribed even if everything else is gated', () => {
  expect(shouldGatePreToolUse(
    { permission_mode: 'default', tool_name: 'Bash' },
    'default', 'auto',
    { sessionAllowList: [], claudeAllowRules: [] },
    /* hasSubscribedClient */ false,
  )).toBe(false);
});
```

Update existing tests to pass `true` for `hasSubscribedClient`.

In `wire.ts`, update the call site:

```typescript
if (!shouldGatePreToolUse(env.raw, knownMode, approvalGate, {
  sessionAllowList: session?.sessionAllowList ?? [],
  claudeAllowRules: session?.claudeAllowRules ?? [],
}, ws.hasSubscribedActionsClient(env.sessionId))) return null;
```

- [ ] **Step 5: Update e2e**

The existing e2e subscribes with `actions` capability so `hasSubscribedActionsClient` is true; it continues to engage approval. Add a new test scenario in `tests/e2e/run-e2e.mjs` after the existing assertions:

```javascript
// New scenario: simulate "no client subscribed" by re-running with WS subscribed but WITHOUT actions cap.
// (Skipped in v1.5 — verification is done via unit tests; the cancellation path is covered by approval-manager tests.)
```

(This is a pragmatic compromise — full multi-client e2e would significantly extend the harness; defer to task 8 where the web UI changes anyway.)

- [ ] **Step 6: Run + commit**

```bash
pnpm test && pnpm e2e
git add packages/hub/src/approval-manager.ts packages/hub/src/approval-manager.test.ts \
  packages/hub/src/ws/server.ts packages/hub/src/ws/connection.ts \
  packages/hub/src/agents/claude/approval-policy.ts \
  packages/hub/src/agents/claude/approval-policy.test.ts \
  packages/hub/src/wire.ts
git commit -m "feat(hub): subscribed-client gating + last-client-gone releases pending approvals"
```

---

## Task 8: Web UI — InteractionPanel + ModeBadge

**Goal:** Web shows the new `session.prompt-request` shape with dynamic options. `ModeBadge` in header shows the current `permissionMode` with claude's glyphs.

**Files:**
- Create: `packages/debug-web/src/components/ModeBadge.tsx` (+test)
- Create: `packages/debug-web/src/components/InteractionPanel.tsx` (+test)
- Delete: `packages/debug-web/src/components/ConfirmationPanel.tsx`
- Modify: `packages/debug-web/src/components/SessionDetail.tsx`

- [ ] **Step 1: Test ModeBadge**

Create `packages/debug-web/src/components/ModeBadge.test.tsx`:

```typescript
import { describe, it, expect } from 'vitest';
import { render } from 'preact';
import { ModeBadge } from './ModeBadge.js';

describe('ModeBadge', () => {
  it('renders nothing for default mode', () => {
    const div = document.createElement('div');
    render(<ModeBadge mode="default" />, div);
    expect(div.querySelector('[data-testid="mode-badge"]')).toBeNull();
  });
  it('renders glyph + short title for non-default', () => {
    const div = document.createElement('div');
    render(<ModeBadge mode="auto" />, div);
    const b = div.querySelector('[data-testid="mode-badge"]')!;
    expect(b).toBeTruthy();
    expect(b.textContent).toContain('Auto');
    expect(b.textContent).toContain('⏵⏵');
  });
});
```

- [ ] **Step 2: Implement ModeBadge**

Create `packages/debug-web/src/components/ModeBadge.tsx`:

```tsx
import type { PermissionMode } from '@sesshin/shared';

const CONFIG: Record<PermissionMode, { title: string; glyph: string; bg: string; fg: string } | null> = {
  default:           null,
  auto:              { title: 'Auto',    glyph: '⏵⏵', bg: '#5a4a00', fg: '#ffd966' },
  acceptEdits:       { title: 'Accept',  glyph: '⏵⏵', bg: '#003a4a', fg: '#79e2ff' },
  bypassPermissions: { title: 'Bypass',  glyph: '⏵⏵', bg: '#4a0000', fg: '#ff8080' },
  dontAsk:           { title: 'DontAsk', glyph: '⏵⏵', bg: '#4a0000', fg: '#ff8080' },
  plan:              { title: 'Plan',    glyph: '⏸',  bg: '#3a004a', fg: '#d29eff' },
};

export function ModeBadge({ mode }: { mode: PermissionMode }) {
  const c = CONFIG[mode];
  if (!c) return null;
  return (
    <span data-testid="mode-badge" style={{
      padding: '2px 8px', borderRadius: 4, fontFamily: 'monospace', fontSize: 12,
      background: c.bg, color: c.fg,
    }}>{c.glyph} {c.title}</span>
  );
}
```

Run: `pnpm --filter @sesshin/debug-web test -- ModeBadge` → PASS.

- [ ] **Step 3: Test InteractionPanel — basic render**

Create `packages/debug-web/src/components/InteractionPanel.test.tsx`:

```typescript
import { describe, it, expect } from 'vitest';
import { render } from 'preact';
import { InteractionPanel } from './InteractionPanel.js';
import { promptRequestsBySession, addPromptRequest } from '../store.js';
import type { WsClient } from '../ws-client.js';

const stub: WsClient = {
  sendAction: () => {}, sendText: () => {},
  sendPromptResponse: () => {}, close: () => {},
};

describe('InteractionPanel', () => {
  beforeEach(() => { promptRequestsBySession.value = {}; });

  it('renders nothing when no pending requests', () => {
    const div = document.createElement('div');
    render(<InteractionPanel ws={stub} sessionId="s1" />, div);
    expect(div.querySelector('[data-testid="interaction-panel"]')).toBeNull();
  });

  it('renders a permission card with options', () => {
    addPromptRequest({
      sessionId: 's1', requestId: 'r1', origin: 'permission', toolName: 'Bash',
      body: '```bash\ngit log\n```',
      questions: [{
        prompt: 'Run this command?', header: 'Bash',
        multiSelect: false, allowFreeText: true,
        options: [
          { key: 'yes',        label: 'Yes' },
          { key: 'yes-prefix', label: 'Yes, don’t ask again' },
          { key: 'no',         label: 'No' },
        ],
      }],
      expiresAt: Date.now() + 60_000,
    });
    const div = document.createElement('div');
    render(<InteractionPanel ws={stub} sessionId="s1" />, div);
    expect(div.querySelector('[data-testid="interaction-panel"]')).toBeTruthy();
    const buttons = div.querySelectorAll('[data-testid^="opt-"]');
    expect(buttons.length).toBe(3);
  });

  it('clicking an option calls sendPromptResponse with the key', async () => {
    let captured: any = null;
    const ws: WsClient = { ...stub, sendPromptResponse: (sid, rid, answers) => { captured = { sid, rid, answers }; } };
    addPromptRequest({
      sessionId: 's1', requestId: 'r1', origin: 'permission', toolName: 'Bash',
      questions: [{
        prompt: 'Run this command?', multiSelect: false, allowFreeText: false,
        options: [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }],
      }],
      expiresAt: Date.now() + 60_000,
    });
    const div = document.createElement('div');
    render(<InteractionPanel ws={ws} sessionId="s1" />, div);
    (div.querySelector('[data-testid="opt-yes"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(captured).toMatchObject({
      sid: 's1', rid: 'r1',
      answers: [{ questionIndex: 0, selectedKeys: ['yes'] }],
    });
  });
});
```

- [ ] **Step 4: Run; FAIL → Implement**

```bash
pnpm --filter @sesshin/debug-web test -- InteractionPanel
```

Create `packages/debug-web/src/components/InteractionPanel.tsx`:

```tsx
import { useState } from 'preact/hooks';
import { promptRequestsBySession, type PendingPromptRequest } from '../store.js';
import type { WsClient } from '../ws-client.js';

function fmtRemaining(expiresAt: number): string {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return 'expiring…';
  return `${Math.ceil(ms / 1000)}s`;
}

function Card({ ws, c }: { ws: WsClient; c: PendingPromptRequest }) {
  const [selected, setSelected] = useState<Record<number, Set<string>>>({});
  const [freeText, setFreeText] = useState<Record<number, string>>({});

  const submit = () => {
    const answers = c.questions.map((q, idx) => ({
      questionIndex: idx,
      selectedKeys: Array.from(selected[idx] ?? []),
      ...(freeText[idx] ? { freeText: freeText[idx] } : {}),
    }));
    ws.sendPromptResponse(c.sessionId, c.requestId, answers);
  };

  // Single-select shortcut: clicking an option picks it AND submits immediately
  const clickOption = (qIdx: number, key: string, multiSelect: boolean) => {
    if (multiSelect) {
      const cur = new Set(selected[qIdx] ?? []);
      if (cur.has(key)) cur.delete(key); else cur.add(key);
      setSelected({ ...selected, [qIdx]: cur });
    } else {
      // Auto-submit for single-select questions when there's only one question
      const next = { ...selected, [qIdx]: new Set([key]) };
      setSelected(next);
      if (c.questions.length === 1) {
        ws.sendPromptResponse(c.sessionId, c.requestId, [{
          questionIndex: qIdx, selectedKeys: [key],
          ...(freeText[qIdx] ? { freeText: freeText[qIdx] } : {}),
        }]);
      }
    }
  };

  return (
    <div data-testid="prompt-card" style={{
      border: '1px solid #b58900', background: '#1c1a0e', color: '#eee',
      padding: 10, borderRadius: 4, marginBottom: 8, fontFamily: 'monospace', fontSize: 13,
    }}>
      <div style={{ marginBottom: 6 }}>
        <span style={{ color: '#f0c674', fontWeight: 600 }}>{c.origin}</span>{' '}
        <span style={{ opacity: 0.7 }}>tool:</span> <b>{c.toolName}</b>
        <span style={{ float: 'right', opacity: 0.6 }}>fallback in {fmtRemaining(c.expiresAt)}</span>
      </div>
      {c.body && <pre style={{
        margin: '0 0 8px 0', padding: 6, background: '#000', color: '#ddd',
        borderRadius: 3, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
        maxHeight: 240, overflowY: 'auto',
      }}>{c.body}</pre>}
      {c.questions.map((q, qIdx) => (
        <div key={qIdx} style={{ marginBottom: 6 }}>
          {c.questions.length > 1 && <div style={{ marginBottom: 4 }}><b>{q.prompt}</b></div>}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {q.options.map((o) => (
              <button key={o.key} data-testid={`opt-${o.key}`}
                      onClick={() => clickOption(qIdx, o.key, q.multiSelect)}
                      title={o.description}
                      style={{
                        padding: '4px 12px',
                        background: (selected[qIdx]?.has(o.key)) ? '#2f5f2f' : '#222',
                        color: '#eee', border: '1px solid #444',
                        fontWeight: o.recommended ? 600 : 400,
                      }}>
                {o.label}{o.recommended ? ' ★' : ''}
              </button>
            ))}
          </div>
          {q.allowFreeText && (
            <div style={{ marginTop: 4 }}>
              <input
                type="text" placeholder="Other / feedback…"
                value={freeText[qIdx] ?? ''}
                onInput={(e) => setFreeText({ ...freeText, [qIdx]: (e.currentTarget as HTMLInputElement).value })}
                style={{ width: '100%', padding: '3px 6px', background: '#000', color: '#ddd', border: '1px solid #444' }}
              />
            </div>
          )}
        </div>
      ))}
      {(c.questions.length > 1 || c.questions.some(q => q.multiSelect)) && (
        <button onClick={submit} style={{ marginTop: 6, padding: '4px 12px', background: '#1f5f2e', color: '#eee' }}>Submit</button>
      )}
    </div>
  );
}

export function InteractionPanel({ ws, sessionId }: { ws: WsClient; sessionId: string }) {
  const list = promptRequestsBySession.value[sessionId] ?? [];
  if (list.length === 0) return null;
  return (
    <div data-testid="interaction-panel" style={{ marginBottom: 12 }}>
      {list.map(c => <Card key={c.requestId} ws={ws} c={c} />)}
    </div>
  );
}
```

Run; PASS.

- [ ] **Step 5: Wire into SessionDetail + delete old panel**

```bash
git rm packages/debug-web/src/components/ConfirmationPanel.tsx
```

In `packages/debug-web/src/components/SessionDetail.tsx`, replace imports and usage:

```tsx
import { selectedSession, summariesBySession, eventsBySession, rawBySession } from '../store.js';
import { StateBadge } from './StateBadge.js';
import { ModeBadge } from './ModeBadge.js';
import { SummaryCard } from './SummaryCard.js';
import { EventTimeline } from './EventTimeline.js';
import { ActionButtons } from './ActionButtons.js';
import { TextInput } from './TextInput.js';
import { InteractionPanel } from './InteractionPanel.js';
import type { WsClient } from '../ws-client.js';

// inside the JSX, replace the header line:
<div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
  <h2 style={{ margin: 0 }}>{s.name}</h2>
  <StateBadge state={s.state} />
  <ModeBadge mode={s.substate.permissionMode} />
</div>

// replace the ConfirmationPanel line with:
<InteractionPanel ws={ws} sessionId={s.id} />
```

- [ ] **Step 6: Build + run all**

```bash
pnpm build
pnpm test && pnpm e2e
```

- [ ] **Step 7: Commit**

```bash
git add packages/debug-web/src/components/ModeBadge.tsx \
  packages/debug-web/src/components/ModeBadge.test.tsx \
  packages/debug-web/src/components/InteractionPanel.tsx \
  packages/debug-web/src/components/InteractionPanel.test.tsx \
  packages/debug-web/src/components/SessionDetail.tsx
git rm packages/debug-web/src/components/ConfirmationPanel.tsx
git commit -m "feat(web): InteractionPanel + ModeBadge replacing ConfirmationPanel"
```

---

## Task 9: REST diagnostics + read-only CLI subcommands

**Goal:** Localhost REST endpoints that expose hub state + matching CLI subcommands (`status`, `clients`, `history`).

**Files:**
- Create: `packages/hub/src/rest/diagnostics.ts` (+test)
- Modify: `packages/hub/src/rest/server.ts` — route the new paths
- Modify: `packages/hub/src/wire.ts` — pass approval manager + ws to diagnostics
- Create: `packages/cli/src/subcommands/status.ts`
- Create: `packages/cli/src/subcommands/clients.ts`
- Create: `packages/cli/src/subcommands/history.ts`
- Modify: `packages/cli/src/main.ts`

- [ ] **Step 1: Test diagnostics endpoint**

Create `packages/hub/src/rest/diagnostics.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRestServer, type RestServer } from './server.js';
import { SessionRegistry } from '../registry/session-registry.js';
import { ApprovalManager } from '../approval-manager.js';

let svr: RestServer; let port: number;
let registry: SessionRegistry;
let approvals: ApprovalManager;

beforeEach(async () => {
  registry = new SessionRegistry();
  approvals = new ApprovalManager({ defaultTimeoutMs: 60_000 });
  svr = createRestServer({
    registry, approvals,
    hasSubscribedActionsClient: () => false,
    listClients: () => [],
    historyForSession: () => [],
  });
  await svr.listen(0, '127.0.0.1');
  port = svr.address().port;
});
afterEach(async () => { await svr.close(); });

describe('GET /api/diagnostics', () => {
  it('returns sessions, gate, allow lists, pending approvals', async () => {
    registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const r = await fetch(`http://127.0.0.1:${port}/api/diagnostics`);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.sessions).toHaveLength(1);
    expect(j.sessions[0]).toMatchObject({
      id: 's1', state: 'starting',
      permissionMode: 'default',
      sessionAllowList: [], claudeAllowRules: [],
      pendingApprovals: 0,
    });
  });
});
```

- [ ] **Step 2: Run; FAIL — Implement**

In `packages/hub/src/rest/diagnostics.ts`:

```typescript
import type { ServerResponse } from 'node:http';
import type { SessionRegistry } from '../registry/session-registry.js';
import type { ApprovalManager } from '../approval-manager.js';

export interface DiagnosticsDeps {
  registry: SessionRegistry;
  approvals: ApprovalManager;
  hasSubscribedActionsClient: (sessionId: string) => boolean;
  listClients: (sessionId: string | null) => ClientInfo[];
  historyForSession: (sessionId: string, n: number) => HistoryEntry[];
}

export interface ClientInfo {
  kind: string; capabilities: string[]; subscribedTo: string[] | 'all';
}
export interface HistoryEntry {
  requestId: string; tool: string; resolvedAt: number;
  decision: 'allow' | 'deny' | 'ask'; reason?: string;
}

export function diagnosticsSnapshot(deps: DiagnosticsDeps) {
  return {
    sessions: deps.registry.list().map((info) => {
      const rec = deps.registry.get(info.id)!;
      return {
        id: info.id,
        name: info.name,
        state: info.state,
        permissionMode: info.substate.permissionMode,
        sessionAllowList: rec.sessionAllowList,
        claudeAllowRules: rec.claudeAllowRules,
        pendingApprovals: deps.approvals.pendingForSession(info.id).length,
        hasSubscribedActionsClient: deps.hasSubscribedActionsClient(info.id),
      };
    }),
  };
}

export function writeDiagnostics(res: ServerResponse, deps: DiagnosticsDeps): void {
  res.writeHead(200, { 'content-type': 'application/json' })
     .end(JSON.stringify(diagnosticsSnapshot(deps)));
}
```

In `packages/hub/src/rest/server.ts`, plumb the new deps and add the route. Add to `RestServerDeps`:

```typescript
import type { ApprovalManager } from '../approval-manager.js';
import type { ClientInfo, HistoryEntry } from './diagnostics.js';

export interface RestServerDeps {
  // …existing…
  approvals?: ApprovalManager;
  hasSubscribedActionsClient?: (sessionId: string) => boolean;
  listClients?: (sessionId: string | null) => ClientInfo[];
  historyForSession?: (sessionId: string, n: number) => HistoryEntry[];
}
```

In `route()`:

```typescript
if (url.pathname === '/api/diagnostics') {
  if (method !== 'GET') return void res.writeHead(405).end();
  if (!deps.approvals) return void res.writeHead(503).end();
  const { writeDiagnostics } = await import('./diagnostics.js');
  return writeDiagnostics(res, {
    registry: deps.registry,
    approvals: deps.approvals,
    hasSubscribedActionsClient: deps.hasSubscribedActionsClient ?? (() => false),
    listClients: deps.listClients ?? (() => []),
    historyForSession: deps.historyForSession ?? (() => []),
  });
}
const cm = url.pathname.match(/^\/api\/sessions\/([^/]+)\/clients$/);
if (cm) {
  const id = cm[1]!;
  if (method !== 'GET') return void res.writeHead(405).end();
  const list = deps.listClients?.(id) ?? [];
  return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(list));
}
const hm = url.pathname.match(/^\/api\/sessions\/([^/]+)\/history$/);
if (hm) {
  const id = hm[1]!;
  if (method !== 'GET') return void res.writeHead(405).end();
  const n = Number(url.searchParams.get('n') ?? 20);
  const list = deps.historyForSession?.(id, n) ?? [];
  return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(list));
}
```

- [ ] **Step 3: Wire `wire.ts`**

In `packages/hub/src/wire.ts`, change `createRestServer` call to pass:

```typescript
approvals,
hasSubscribedActionsClient: (sid) => ws.hasSubscribedActionsClient(sid),
listClients: (sid) => ws.listClients(sid),
historyForSession: (sid, n) => historyStore.get(sid, n),
```

Add a small in-memory history store at module scope (replace `let wsRef: WsServerInstance | null = null;` block):

```typescript
const historyStore = (() => {
  const map = new Map<string, import('./rest/diagnostics.js').HistoryEntry[]>();
  return {
    push(sid: string, e: import('./rest/diagnostics.js').HistoryEntry): void {
      const arr = map.get(sid) ?? [];
      arr.push(e);
      if (arr.length > 100) arr.shift();
      map.set(sid, arr);
    },
    get(sid: string, n: number): import('./rest/diagnostics.js').HistoryEntry[] {
      return (map.get(sid) ?? []).slice(-n).reverse();
    },
  };
})();
```

In `onPromptResponse` after `approvals.decide`, push history:

```typescript
historyStore.push(sessionId, {
  requestId, tool: slot.tool, resolvedAt: Date.now(),
  decision: outcome.decision,
  ...(outcome.reason ? { reason: outcome.reason } : {}),
});
```

Add `listClients` to the WS server (similar pattern as `hasSubscribedActionsClient`). In `ws/server.ts`:

```typescript
listClients(sessionId: string | null): ClientInfo[] {
  const out: ClientInfo[] = [];
  for (const [_ws, t] of targets) {
    const subscribed = t.subscribedToValue();   // see below
    if (sessionId !== null && subscribed !== 'all' && !subscribed.has(sessionId)) continue;
    out.push({ kind: t.kindValue(), capabilities: Array.from(t.caps()), subscribedTo: subscribed === 'all' ? 'all' : Array.from(subscribed) });
  }
  return out;
}
```

Extend `BroadcastTarget` interface to include the value getters used above (export them via `kindValue: () => string`, `subscribedToValue: () => Set<string> | 'all'`). Adapt `connection.ts`'s `registerTarget` to set them.

- [ ] **Step 4: CLI subcommands**

Create `packages/cli/src/subcommands/status.ts`:

```typescript
const HUB = process.env['SESSHIN_HUB_URL'] ?? 'http://127.0.0.1:9663';

export async function runStatus(opts: { sessionId?: string; json?: boolean }): Promise<number> {
  const r = await fetch(`${HUB}/api/diagnostics`);
  if (!r.ok) { process.stderr.write(`hub error ${r.status}\n`); return 1; }
  const j = await r.json();
  const sessions = opts.sessionId ? j.sessions.filter((s: any) => s.id === opts.sessionId) : j.sessions;
  if (opts.json) {
    process.stdout.write(JSON.stringify({ sessions }, null, 2) + '\n');
    return 0;
  }
  for (const s of sessions) {
    process.stdout.write(`${s.id}  ${s.state}  mode=${s.permissionMode}  pending=${s.pendingApprovals}  clients=${s.hasSubscribedActionsClient ? 'yes' : 'no'}\n`);
    if (s.sessionAllowList.length) process.stdout.write(`  session allow:  ${s.sessionAllowList.join(', ')}\n`);
    if (s.claudeAllowRules.length)  process.stdout.write(`  claude allow:   ${s.claudeAllowRules.join(', ')}\n`);
  }
  return 0;
}
```

Create `packages/cli/src/subcommands/clients.ts`:

```typescript
const HUB = process.env['SESSHIN_HUB_URL'] ?? 'http://127.0.0.1:9663';

export async function runClients(opts: { sessionId?: string; json?: boolean }): Promise<number> {
  const path = opts.sessionId ? `/api/sessions/${opts.sessionId}/clients` : '/api/sessions';
  const r = await fetch(`${HUB}${path}`);
  if (!r.ok) { process.stderr.write(`hub error ${r.status}\n`); return 1; }
  const j = await r.json();
  if (opts.json) { process.stdout.write(JSON.stringify(j, null, 2) + '\n'); return 0; }
  if (!opts.sessionId) {
    process.stdout.write('Use --session <id> to list clients per session.\n');
    return 0;
  }
  for (const c of j) {
    process.stdout.write(`${c.kind}  caps=[${c.capabilities.join(',')}]  subs=${Array.isArray(c.subscribedTo) ? c.subscribedTo.join(',') : c.subscribedTo}\n`);
  }
  return 0;
}
```

Create `packages/cli/src/subcommands/history.ts`:

```typescript
const HUB = process.env['SESSHIN_HUB_URL'] ?? 'http://127.0.0.1:9663';

export async function runHistory(opts: { sessionId: string; n?: number; json?: boolean }): Promise<number> {
  const r = await fetch(`${HUB}/api/sessions/${opts.sessionId}/history?n=${opts.n ?? 20}`);
  if (!r.ok) { process.stderr.write(`hub error ${r.status}\n`); return 1; }
  const j = await r.json();
  if (opts.json) { process.stdout.write(JSON.stringify(j, null, 2) + '\n'); return 0; }
  for (const e of j) {
    const t = new Date(e.resolvedAt).toISOString().slice(11, 19);
    process.stdout.write(`${t}  ${e.tool.padEnd(16)} ${e.decision}${e.reason ? '  // ' + e.reason : ''}\n`);
  }
  return 0;
}
```

- [ ] **Step 5: Wire subcommand dispatch**

In `packages/cli/src/main.ts`, find the subcommand dispatch (currently routes `claude`). Replace with:

```typescript
import { runClaude } from './claude.js';
import { runStatus } from './subcommands/status.js';
import { runClients } from './subcommands/clients.js';
import { runHistory } from './subcommands/history.js';

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'claude': await runClaude(rest); return 0;
    case 'status': {
      const sid = pickFlag(rest, '--session');
      const json = rest.includes('--json');
      return runStatus({ ...(sid ? { sessionId: sid } : {}), json });
    }
    case 'clients': {
      const sid = pickFlag(rest, '--session');
      const json = rest.includes('--json');
      return runClients({ ...(sid ? { sessionId: sid } : {}), json });
    }
    case 'history': {
      const sid = pickFlag(rest, '--session') ?? process.env['SESSHIN_SESSION_ID'];
      if (!sid) { process.stderr.write('history: --session required (or SESSHIN_SESSION_ID env)\n'); return 2; }
      const nStr = pickFlag(rest, '-n');
      return runHistory({ sessionId: sid, ...(nStr ? { n: Number(nStr) } : {}), json: rest.includes('--json') });
    }
    default:
      process.stderr.write(`usage: sesshin <claude|status|clients|history> …\n`);
      return 2;
  }
}

function pickFlag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

main().then((code) => process.exit(code)).catch(() => process.exit(1));
```

- [ ] **Step 6: Run + commit**

```bash
pnpm build
pnpm test && pnpm e2e
git add packages/hub/src/rest/diagnostics.ts packages/hub/src/rest/diagnostics.test.ts \
  packages/hub/src/rest/server.ts packages/hub/src/ws/server.ts packages/hub/src/ws/connection.ts \
  packages/hub/src/wire.ts \
  packages/cli/src/subcommands/status.ts packages/cli/src/subcommands/clients.ts packages/cli/src/subcommands/history.ts \
  packages/cli/src/main.ts
git commit -m "feat(cli,hub): /api/diagnostics + sesshin status/clients/history subcommands"
```

---

## Task 10: Slash commands bundle

**Goal:** Bundle `.md` slash commands and ship them via the per-session `--settings` plugin entry (with empirical probe). Initial: read-only commands (`/sesshin-status`, `/sesshin-clients`, `/sesshin-history`).

**Files:**
- Create: `packages/cli/src/commands-bundle/sesshin-status.md`
- Create: `packages/cli/src/commands-bundle/sesshin-clients.md`
- Create: `packages/cli/src/commands-bundle/sesshin-history.md`
- Modify: `packages/cli/src/settings-tempfile.ts`
- Modify: `packages/cli/src/claude.ts`
- Modify: `packages/cli/tsup.config.ts` — copy commands-bundle into dist

- [ ] **Step 1: Empirical probe — does `--settings` honour `enabledPlugins`?**

Run a quick check:

```bash
mkdir -p /tmp/sesshin-probe-plugin/commands
cat > /tmp/sesshin-probe-plugin/manifest.json <<'EOF'
{ "name": "sesshin-probe", "commandsPath": "./commands" }
EOF
cat > /tmp/sesshin-probe-plugin/commands/sesshin-probe.md <<'EOF'
---
description: probe
---
say "hello from sesshin probe"
EOF
cat > /tmp/sesshin-probe-settings.json <<'EOF'
{
  "enabledPlugins": { "sesshin-probe": "/tmp/sesshin-probe-plugin" }
}
EOF
claude -p --settings /tmp/sesshin-probe-settings.json --model claude-haiku-4-5 '/sesshin-probe' < /dev/null 2>&1 | head -20
```

Expected outcomes:
- **A. Plugin path works**: `claude` outputs "hello from sesshin probe" (or quotes around it). Bundle path = plugin entry. Continue with steps 2-6.
- **B. Plugin path doesn't work**: `claude` says "unknown command" or similar. Fall back to `~/.claude/commands/` install via `sesshin commands install`. Skip steps 2 + 5; do step 7 instead.

- [ ] **Step 2 (path A): Author the three commands**

Create `packages/cli/src/commands-bundle/sesshin-status.md`:

```markdown
---
description: Show current sesshin session status (mode, gate, pending approvals, clients)
allowed-tools: Bash(sesshin status:*)
---

Run this command to fetch sesshin's view of the current session:

```bash
sesshin status --session $SESSHIN_SESSION_ID --json
```

Then summarise the result for the user: current permission mode, gate policy, number of subscribed clients, count of pending approvals, any active session-allow rules.
```

Create `packages/cli/src/commands-bundle/sesshin-clients.md`:

```markdown
---
description: List remote clients (web/IM/device adapters) currently subscribed to this session
allowed-tools: Bash(sesshin clients:*)
---

```bash
sesshin clients --session $SESSHIN_SESSION_ID --json
```

For each client, show: kind (debug-web / telegram-adapter / m5stick / …), declared capabilities, subscription set.
```

Create `packages/cli/src/commands-bundle/sesshin-history.md`:

```markdown
---
description: Show last N remote-resolved permission decisions for this session
allowed-tools: Bash(sesshin history:*)
---

```bash
sesshin history --session $SESSHIN_SESSION_ID -n ${ARGUMENTS:-20} --json
```

Print each entry with timestamp (HH:MM:SS), tool name, decision (allow/deny/ask), and reason if any.
```

- [ ] **Step 3: Inject plugin entry in settings tempfile**

In `packages/cli/src/settings-tempfile.ts`, extend the input + emit:

```typescript
export interface HooksSettingsInput {
  hookHandlerPath: string;
  sessionId: string;
  hubUrl: string;
  agent: 'claude-code';
  pluginPath?: string;   // when set, emit enabledPlugins block
  pluginName?: string;
}

export function generateHooksOnlySettings(o: HooksSettingsInput): string {
  const hooks: Record<string, unknown> = {};
  for (const evt of EVENTS) {
    hooks[evt] = [{ matcher: '*', hooks: [{ type: 'command', command: buildCommand(o, evt) }] }];
  }
  const out: Record<string, unknown> = { hooks };
  if (o.pluginPath && o.pluginName) {
    out['enabledPlugins'] = { [o.pluginName]: o.pluginPath };
  }
  return JSON.stringify(out, null, 2);
}
```

Update test `settings-tempfile.test.ts` accordingly.

- [ ] **Step 4: Wire plugin path in claude.ts**

In `packages/cli/src/claude.ts`, before writing the temp settings file:

```typescript
import { fileURLToPath } from 'node:url';
import { dirname as _dirname, join as _join } from 'node:path';
import { existsSync as _existsSync, mkdirSync as _mkdirSync, writeFileSync as _writeFileSync, readdirSync as _readdirSync, copyFileSync as _copyFileSync } from 'node:fs';

function ensurePluginDir(): { name: string; path: string } | null {
  // Bundled commands-bundle/*.md ship in dist next to main.js.
  const distDir = _dirname(fileURLToPath(import.meta.url));
  const bundledCommands = _join(distDir, 'commands-bundle');
  if (!_existsSync(bundledCommands)) return null;

  // Per-session plugin scratch under tmpdir
  const pluginRoot = _join(tmpdir(), `sesshin-plugin-${sessionId}`);
  const pluginCmds = _join(pluginRoot, 'commands');
  _mkdirSync(pluginCmds, { recursive: true });
  _writeFileSync(_join(pluginRoot, 'manifest.json'),
    JSON.stringify({ name: 'sesshin', commandsPath: './commands' }), { mode: 0o600 });
  for (const f of _readdirSync(bundledCommands)) {
    _copyFileSync(_join(bundledCommands, f), _join(pluginCmds, f));
  }
  return { name: 'sesshin', path: pluginRoot };
}

const pluginEntry = ensurePluginDir();

let settings: object = JSON.parse(generateHooksOnlySettings({
  hookHandlerPath: hookBin, sessionId, hubUrl: HUB_URL, agent: 'claude-code',
  ...(pluginEntry ? { pluginPath: pluginEntry.path, pluginName: pluginEntry.name } : {}),
}));
```

Add cleanup of the plugin dir in `installCleanup`'s `onShutdown`:

```typescript
import { rmSync as _rmSync } from 'node:fs';
// in onShutdown:
if (pluginEntry) try { _rmSync(pluginEntry.path, { recursive: true, force: true }); } catch {}
```

- [ ] **Step 5: Update build to copy commands-bundle**

In `packages/cli/tsup.config.ts`, ensure the `.md` files are copied to `dist/commands-bundle/`. If using tsup, append a postbuild script in `package.json`:

```json
"build": "tsup && mkdir -p dist/commands-bundle && cp -r src/commands-bundle/*.md dist/commands-bundle/"
```

- [ ] **Step 6: Run + verify (Path A)**

```bash
pnpm build
pkill -f sesshin-hub 2>/dev/null
rm -f ~/.cache/sesshin/sessions.json
packages/cli/bin/sesshin claude
# In claude TUI, type: /sesshin-status
# Expected: claude runs `sesshin status …` and reports the session info.
```

- [ ] **Step 7 (alternative — Path B): `sesshin commands install`**

If Step 1 showed plugins via `--settings` aren't honoured, instead add a CLI subcommand:

In `packages/cli/src/main.ts` add:

```typescript
case 'commands': {
  const sub = rest[0];
  if (sub === 'install')   return runCommandsInstall();
  if (sub === 'uninstall') return runCommandsUninstall();
  process.stderr.write('usage: sesshin commands <install|uninstall>\n');
  return 2;
}
```

Create `packages/cli/src/subcommands/commands-install.ts` that copies `dist/commands-bundle/*.md` into `~/.claude/commands/`. The install is opt-in; document it in README.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/commands-bundle/ packages/cli/src/settings-tempfile.ts \
  packages/cli/src/settings-tempfile.test.ts packages/cli/src/claude.ts \
  packages/cli/package.json
git commit -m "feat(cli): bundled /sesshin-* slash commands (status/clients/history)"
```

---

## Task 11: Mutating slash commands + REST

**Goal:** `/sesshin-trust`, `/sesshin-gate`, `/sesshin-pin`, `/sesshin-quiet`. Each has a CLI subcommand and a corresponding mutating REST endpoint.

**Files:**
- Modify: `packages/hub/src/rest/server.ts` (4 new POST routes)
- Modify: `packages/hub/src/rest/diagnostics.ts` — add `pinByTab`, `quietUntil` to snapshot
- Modify: `packages/hub/src/wire.ts` — pass per-session pin/quiet state
- Modify: `packages/hub/src/registry/session-registry.ts` — `setSessionGateOverride`, `setPin`, `setQuietUntil`, `addSessionAllow`
- Create: `packages/cli/src/subcommands/{trust,gate,pin,quiet}.ts`
- Modify: `packages/cli/src/main.ts`
- Create: `packages/cli/src/commands-bundle/sesshin-{trust,gate,pin,quiet}.md`

- [ ] **Step 1: Registry mutators — test first**

In `session-registry.test.ts`:

```typescript
it('addSessionAllow appends rules; idempotent on dup', () => {
  const r = makeReg();
  r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
  r.addSessionAllow('s1', 'Bash(git log:*)');
  r.addSessionAllow('s1', 'Bash(git log:*)');
  expect(r.get('s1')?.sessionAllowList).toEqual(['Bash(git log:*)']);
});

it('setSessionGateOverride is read via getSessionGateOverride', () => {
  const r = makeReg();
  r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
  r.setSessionGateOverride('s1', 'always');
  expect(r.getSessionGateOverride('s1')).toBe('always');
});

it('pin and quiet round-trip', () => {
  const r = makeReg();
  r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
  r.setPin('s1', 'hello');
  expect(r.getPin('s1')).toBe('hello');
  r.setQuietUntil('s1', 1234);
  expect(r.getQuietUntil('s1')).toBe(1234);
});
```

- [ ] **Step 2: Implement registry mutators**

In `session-registry.ts`, extend `SessionRecord`:

```typescript
export interface SessionRecord extends SessionInfo {
  // …existing…
  sessionGateOverride: 'disabled' | 'auto' | 'always' | null;
  pin: string | null;
  quietUntil: number | null;
}
```

In `register()`, init these to null. Add methods:

```typescript
addSessionAllow(id: string, rule: string): boolean {
  const s = this.sessions.get(id);
  if (!s) return false;
  if (s.sessionAllowList.includes(rule)) return false;
  s.sessionAllowList.push(rule);
  return true;
}
removeSessionAllow(id: string, rule: string): boolean {
  const s = this.sessions.get(id);
  if (!s) return false;
  const before = s.sessionAllowList.length;
  s.sessionAllowList = s.sessionAllowList.filter(r => r !== rule);
  return s.sessionAllowList.length !== before;
}
setSessionGateOverride(id: string, p: 'disabled'|'auto'|'always'): boolean {
  const s = this.sessions.get(id);
  if (!s) return false;
  s.sessionGateOverride = p;
  return true;
}
getSessionGateOverride(id: string): 'disabled'|'auto'|'always'|null {
  return this.sessions.get(id)?.sessionGateOverride ?? null;
}
setPin(id: string, msg: string | null): boolean {
  const s = this.sessions.get(id);
  if (!s) return false;
  s.pin = msg;
  return true;
}
getPin(id: string): string | null { return this.sessions.get(id)?.pin ?? null; }
setQuietUntil(id: string, ts: number | null): boolean {
  const s = this.sessions.get(id);
  if (!s) return false;
  s.quietUntil = ts;
  return true;
}
getQuietUntil(id: string): number | null { return this.sessions.get(id)?.quietUntil ?? null; }
```

Run: `pnpm --filter @sesshin/hub test -- session-registry` → PASS.

- [ ] **Step 3: REST routes — add to `route()` in server.ts**

```typescript
const tm = url.pathname.match(/^\/api\/sessions\/([^/]+)\/trust$/);
if (tm) {
  const id = tm[1]!;
  if (method !== 'POST') return void res.writeHead(405).end();
  let body: any; try { body = await readJson(req); } catch { return void res.writeHead(400).end(); }
  const rule = typeof body?.ruleString === 'string' ? body.ruleString : null;
  if (!rule) return void res.writeHead(400).end('ruleString required');
  const ok = deps.registry.addSessionAllow(id, rule);
  return void res.writeHead(ok ? 204 : 404).end();
}
const gm = url.pathname.match(/^\/api\/sessions\/([^/]+)\/gate$/);
if (gm) {
  const id = gm[1]!;
  if (method !== 'POST') return void res.writeHead(405).end();
  let body: any; try { body = await readJson(req); } catch { return void res.writeHead(400).end(); }
  const p = body?.policy;
  if (!['disabled','auto','always'].includes(p)) return void res.writeHead(400).end();
  return void res.writeHead(deps.registry.setSessionGateOverride(id, p) ? 204 : 404).end();
}
const pm = url.pathname.match(/^\/api\/sessions\/([^/]+)\/pin$/);
if (pm) {
  const id = pm[1]!;
  if (method !== 'POST') return void res.writeHead(405).end();
  let body: any; try { body = await readJson(req); } catch { return void res.writeHead(400).end(); }
  const msg = body?.message ?? null;
  return void res.writeHead(deps.registry.setPin(id, typeof msg === 'string' ? msg : null) ? 204 : 404).end();
}
const qm = url.pathname.match(/^\/api\/sessions\/([^/]+)\/quiet$/);
if (qm) {
  const id = qm[1]!;
  if (method !== 'POST') return void res.writeHead(405).end();
  let body: any; try { body = await readJson(req); } catch { return void res.writeHead(400).end(); }
  const ttl = Number(body?.ttlMs ?? 0);
  if (!Number.isFinite(ttl) || ttl < 0) return void res.writeHead(400).end();
  const until = ttl > 0 ? Date.now() + ttl : null;
  return void res.writeHead(deps.registry.setQuietUntil(id, until) ? 204 : 404).end();
}
```

- [ ] **Step 4: Wire gate-override into approval policy**

In `wire.ts`, when computing `approvalGate` per call, prefer the session override:

```typescript
const sessionPolicy = registry.getSessionGateOverride(env.sessionId);
const policyForCall = sessionPolicy ?? approvalGate;
if (!shouldGatePreToolUse(env.raw, knownMode, policyForCall, {
  // …
}, ws.hasSubscribedActionsClient(env.sessionId))) return null;
```

- [ ] **Step 5: CLI subcommands**

Create `packages/cli/src/subcommands/trust.ts`:

```typescript
const HUB = process.env['SESSHIN_HUB_URL'] ?? 'http://127.0.0.1:9663';
export async function runTrust(opts: { sessionId: string; ruleString: string }): Promise<number> {
  const r = await fetch(`${HUB}/api/sessions/${opts.sessionId}/trust`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ruleString: opts.ruleString }),
  });
  if (r.status === 204) { process.stdout.write(`trusted: ${opts.ruleString}\n`); return 0; }
  process.stderr.write(`hub error ${r.status}\n`); return 1;
}
```

Similarly create `gate.ts`, `pin.ts`, `quiet.ts` (each ~10 lines). For `quiet.ts`, parse durations like `5m`/`30s`/`1h`:

```typescript
function parseDuration(s: string): number {
  const m = /^(\d+)(s|m|h)?$/.exec(s);
  if (!m) return NaN;
  const n = Number(m[1]); const u = m[2] ?? 's';
  return n * (u === 'h' ? 3_600_000 : u === 'm' ? 60_000 : 1_000);
}
```

In `main.ts`, add cases:

```typescript
case 'trust': {
  const sid = pickFlag(rest, '--session') ?? process.env['SESSHIN_SESSION_ID'];
  const rule = rest.find(a => !a.startsWith('--'));
  if (!sid || !rule) { process.stderr.write('usage: sesshin trust <ruleString> [--session <id>]\n'); return 2; }
  return runTrust({ sessionId: sid, ruleString: rule });
}
// gate / pin / quiet similar
```

- [ ] **Step 6: Slash command markdowns**

Create `packages/cli/src/commands-bundle/sesshin-trust.md`:

```markdown
---
description: Add a sesshin session-allow rule (Tool[(content)]) so future matching tool calls skip the remote-approval prompt
allowed-tools: Bash(sesshin trust:*)
argument-hint: <Tool(content)>
---

```bash
sesshin trust "${ARGUMENTS}" --session $SESSHIN_SESSION_ID
```

Confirm what was added to the user.
```

Similarly create `sesshin-gate.md`, `sesshin-pin.md`, `sesshin-quiet.md`.

- [ ] **Step 7: Run + commit**

```bash
pnpm build
pnpm test && pnpm e2e
git add packages/hub/src/registry/session-registry.ts \
  packages/hub/src/registry/session-registry.test.ts \
  packages/hub/src/rest/server.ts packages/hub/src/wire.ts \
  packages/cli/src/subcommands/trust.ts packages/cli/src/subcommands/gate.ts \
  packages/cli/src/subcommands/pin.ts packages/cli/src/subcommands/quiet.ts \
  packages/cli/src/main.ts \
  packages/cli/src/commands-bundle/sesshin-trust.md \
  packages/cli/src/commands-bundle/sesshin-gate.md \
  packages/cli/src/commands-bundle/sesshin-pin.md \
  packages/cli/src/commands-bundle/sesshin-quiet.md
git commit -m "feat(cli,hub): /sesshin-trust + /sesshin-gate + /sesshin-pin + /sesshin-quiet"
```

---

## Task 12: Documentation

**Goal:** README + architecture doc reflect v1.5.

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`

- [ ] **Step 1: Update README**

Add sections to `README.md`:

```markdown
## Permission gating

When you run sesshin claude, sesshin observes Claude Code's PreToolUse hook
to surface tool-use confirmations on connected remote clients. Behaviour is
mode-aware: in `auto`/`acceptEdits`/`bypassPermissions`/`dontAsk`/`plan`
mode, sesshin is transparent. In `default` mode, write-class tools (Bash,
Edit, Write, MultiEdit, NotebookEdit, PowerShell, WebFetch) trigger a
remote `session.prompt-request` that the web user can answer.

If no client is subscribed, sesshin falls back to Claude's TUI prompt. So:

- Open the web UI to take over.
- Close it to give control back to the laptop.

Env vars:

- `SESSHIN_APPROVAL_GATE`  — `disabled` | `auto` (default) | `always`
- `SESSHIN_APPROVAL_TIMEOUT_MS` — hub-side timeout before falling back to
  TUI (default 60_000)

## Slash commands

Sesshin ships these `/sesshin-*` commands, available from inside any
sesshin-wrapped Claude session (no extra install needed when plugins are
honoured via `--settings`):

| Command | Purpose |
|---|---|
| /sesshin-status | Current mode, gate, pending approvals, clients |
| /sesshin-clients | List connected web/IM/device adapters |
| /sesshin-history | Last N remotely resolved decisions |
| /sesshin-trust  | Add a session-allow rule, e.g. `Bash(git log:*)` |
| /sesshin-gate   | Override gate policy for this session |
| /sesshin-pin    | Sticky note shown on remote clients |
| /sesshin-quiet  | Suspend remote notifications for a duration |
```

- [ ] **Step 2: Update architecture doc**

In `docs/architecture.md`, append a section linking to the v1.5 spec:

```markdown
## v1.5 — Ambient remote control

See `docs/superpowers/specs/2026-05-03-ambient-remote-control-v1.5-design.md`
for the design of mode-aware approval gating, the unified
`session.prompt-request` wire shape, and the per-tool interaction handler
registry.
```

- [ ] **Step 3: Commit**

```bash
git add README.md docs/architecture.md
git commit -m "docs: README + architecture notes for v1.5 ambient control"
```

---

## Self-review checklist (engineer-side, before starting)

- All 12 tasks are independently shippable and committed.
- Each TDD pair (failing test → implement → passing test) is real (no skipped runs).
- Renames `session.confirmation` → `session.prompt-request` happen in one commit (Task 4) so debug-web stays in sync.
- `Substate.permissionMode` defaults to `'default'`, so old checkpoints load fine.
- `shouldGatePreToolUse` signature changes are made in lockstep across tests + call site (Tasks 3, 6, 7).
- `setCatchAllToolName` is a transient module-level state hack documented in Task 5 step 16.
- The Task 10 plugin-via-settings probe must be run before committing Task 10's code; if Path B (manual install) is needed, swap accordingly.
- Tests + e2e are green at the end of every commit.

