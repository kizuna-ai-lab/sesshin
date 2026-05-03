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
