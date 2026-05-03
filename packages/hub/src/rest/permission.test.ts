import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRestServer, type RestServer } from './server.js';
import { SessionRegistry } from '../registry/session-registry.js';
import { ApprovalManager } from '../approval-manager.js';

let svr: RestServer | undefined;
let port: number;
let registry: SessionRegistry;
let approvals: ApprovalManager;

beforeEach(() => {
  registry = new SessionRegistry();
  approvals = new ApprovalManager({ defaultTimeoutMs: 60_000 });
  registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
});
afterEach(async () => { if (svr) { await svr.close(); svr = undefined; } });

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
  it('returns the allow decision shape with updatedPermissions when callback supplies them', async () => {
    svr = createRestServer({
      registry, approvals,
      onPermissionRequestApproval: async () => ({
        behavior: 'allow',
        updatedPermissions: [{ type: 'setMode', destination: 'session', mode: 'acceptEdits' }],
      }),
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
        decision: {
          behavior: 'allow',
          updatedPermissions: [{ type: 'setMode', destination: 'session', mode: 'acceptEdits' }],
        },
      },
    });
  });
  it('returns allow with both updatedInput and updatedPermissions when callback supplies both', async () => {
    svr = createRestServer({
      registry, approvals,
      onPermissionRequestApproval: async () => ({
        behavior: 'allow',
        updatedInput: { foo: 'bar' },
        updatedPermissions: [{ type: 'setMode', destination: 'session', mode: 'default' }],
      }),
    });
    await svr.listen(0, '127.0.0.1');
    port = svr.address().port;
    const r = await fetch(`http://127.0.0.1:${port}/permission/s1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(PERM_BODY()),
    });
    const j = await r.json();
    expect(j.hookSpecificOutput.decision).toEqual({
      behavior: 'allow',
      updatedInput: { foo: 'bar' },
      updatedPermissions: [{ type: 'setMode', destination: 'session', mode: 'default' }],
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
  it('returns 204 when no callback registered', async () => {
    svr = createRestServer({ registry, approvals });
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
    expect(env.raw['session_id']).toBe('claude-uuid');
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

describe('POST /permission/:sessionId — failure modes', () => {
  it('body > 512 KB → 200 + deny "too large"', async () => {
    svr = createRestServer({
      registry, approvals,
      onPermissionRequestApproval: async () => ({ behavior: 'allow' }),
    });
    await svr.listen(0, '127.0.0.1');
    port = svr.address().port;
    const huge = { ...(PERM_BODY() as object), tool_input: { command: 'x'.repeat(600_000) } };
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
    expect(onHookEvent).toHaveBeenCalledTimes(1);
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

// Integration-level test that exercises the cross-route invariants the wire
// adapter is responsible for: PermissionRequest sets usesPermissionRequest,
// and subsequent PreToolUse for that session passes through; PreToolUse for a
// DIFFERENT session still flows the gate.
describe('integration: PermissionRequest opt-in suppresses subsequent PreToolUse', () => {
  it('PermissionRequest then PreToolUse on same session → PreToolUse 204s through', async () => {
    // Wire adapter equivalent: the PreToolUse callback consults registry
    // to honor usesPermissionRequest (mirrors wire.ts logic).
    const onPreToolUseApproval = vi.fn(async (env: { sessionId: string }) => {
      if (registry.get(env.sessionId)?.usesPermissionRequest === true) return null;
      return { decision: 'ask' as const };
    });
    svr = createRestServer({
      registry, approvals,
      onPreToolUseApproval,
      onPermissionRequestApproval: async () => null,
    });
    await svr.listen(0, '127.0.0.1');
    port = svr.address().port;

    // Step 1: PermissionRequest hit on s1 — sets the flag.
    await fetch(`http://127.0.0.1:${port}/permission/s1`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(PERM_BODY()),
    });
    expect(registry.get('s1')!.usesPermissionRequest).toBe(true);

    // Step 2: PreToolUse on s1 — should 204 because callback returns null.
    const pre = await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: 'claude-code', sessionId: 's1', ts: Date.now(), event: 'PreToolUse',
        raw: { nativeEvent: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
      }),
    });
    expect(pre.status).toBe(204);
    expect(onPreToolUseApproval).toHaveBeenCalledTimes(1);
  });
  it('different session has no opt-in; PreToolUse still drives a decision', async () => {
    registry.register({ id: 's2', name: 'n', agent: 'claude-code', cwd: '/', pid: 2, sessionFilePath: '/x' });
    const onPreToolUseApproval = vi.fn(async (env: { sessionId: string }) => {
      if (registry.get(env.sessionId)?.usesPermissionRequest === true) return null;
      return { decision: 'ask' as const, reason: 'no opt-in' };
    });
    svr = createRestServer({ registry, approvals, onPreToolUseApproval });
    await svr.listen(0, '127.0.0.1');
    port = svr.address().port;

    expect(registry.get('s2')!.usesPermissionRequest).toBe(false);
    const r = await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: 'claude-code', sessionId: 's2', ts: Date.now(), event: 'PreToolUse',
        raw: { nativeEvent: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
      }),
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.hookSpecificOutput.permissionDecision).toBe('ask');
  });
  it('PostToolUse cleanup of a stale pending approval invokes onApprovalsCleanedUp with the requestId', async () => {
    const cleaned: Array<{ sessionId: string; requestIds: string[] }> = [];
    svr = createRestServer({
      registry, approvals,
      onApprovalsCleanedUp: (sessionId, requestIds) => cleaned.push({ sessionId, requestIds }),
    });
    await svr.listen(0, '127.0.0.1');
    port = svr.address().port;

    // Open an approval directly so the PostToolUse cleanup has something to find.
    const { request } = approvals.open({
      sessionId: 's1', tool: 'Bash', toolInput: { command: 'ls' }, toolUseId: 'tu_stale',
    });

    const r = await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: 'claude-code', sessionId: 's1', ts: Date.now(), event: 'PostToolUse',
        raw: {
          nativeEvent: 'PostToolUse', tool_name: 'Bash',
          tool_input: { command: 'ls' }, tool_use_id: 'tu_stale',
        },
      }),
    });
    expect(r.status).toBe(204);
    expect(cleaned).toEqual([{ sessionId: 's1', requestIds: [request.requestId] }]);
  });

  it('does NOT invoke onApprovalsCleanedUp when no pending approval matches', async () => {
    const cleaned: Array<{ sessionId: string; requestIds: string[] }> = [];
    svr = createRestServer({
      registry, approvals,
      onApprovalsCleanedUp: (sessionId, requestIds) => cleaned.push({ sessionId, requestIds }),
    });
    await svr.listen(0, '127.0.0.1');
    port = svr.address().port;

    // No prior approvals.open — PostToolUse should be a no-op for cleanup.
    await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: 'claude-code', sessionId: 's1', ts: Date.now(), event: 'PostToolUse',
        raw: {
          nativeEvent: 'PostToolUse', tool_name: 'Bash',
          tool_input: { command: 'ls' }, tool_use_id: 'tu_nope',
        },
      }),
    });
    expect(cleaned).toEqual([]);
  });

  it('full flow — PermissionRequest pending then PostToolUse with same tool_use_id resolves it', async () => {
    let resolvedDecision: { decision: string; reason?: string } | undefined;
    svr = createRestServer({
      registry, approvals,
      onPermissionRequestApproval: async (env) => {
        // Open a real pending entry tracked via the same approvals we share
        // with the cleanup branch on /hooks.
        const tuid = typeof env.raw['tool_use_id'] === 'string' ? env.raw['tool_use_id'] : undefined;
        const { decision } = approvals.open({
          sessionId: env.sessionId, tool: 'Bash',
          toolInput: env.raw['tool_input'] ?? {},
          ...(tuid !== undefined ? { toolUseId: tuid } : {}),
        });
        const out = await decision;
        resolvedDecision = out;
        if (out.decision === 'allow')  return { behavior: 'allow' };
        if (out.decision === 'deny')   return { behavior: 'deny', ...(out.reason !== undefined ? { message: out.reason } : {}) };
        return null;
      },
    });
    await svr.listen(0, '127.0.0.1');
    port = svr.address().port;

    // Kick off the PermissionRequest — it'll pend until cleanup fires.
    const prPromise = fetch(`http://127.0.0.1:${port}/permission/s1`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(PERM_BODY({ tool_use_id: 'tu_e2e' })),
    });
    // Give the route a beat to call approvals.open.
    await new Promise((r) => setTimeout(r, 50));
    expect(approvals.pendingForSession('s1')).toHaveLength(1);

    // PostToolUse with matching tool_use_id should clean up the pending entry.
    await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: 'claude-code', sessionId: 's1', ts: Date.now(), event: 'PostToolUse',
        raw: {
          nativeEvent: 'PostToolUse', tool_name: 'Bash',
          tool_input: { command: 'ls' }, tool_use_id: 'tu_e2e',
        },
      }),
    });
    expect(approvals.pendingForSession('s1')).toHaveLength(0);

    const r = await prPromise;
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.hookSpecificOutput.decision.behavior).toBe('deny');
    expect(j.hookSpecificOutput.decision.message).toContain('moved past pending request');
    expect(resolvedDecision?.decision).toBe('deny');
  });
});
