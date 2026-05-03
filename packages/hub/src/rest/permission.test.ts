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
