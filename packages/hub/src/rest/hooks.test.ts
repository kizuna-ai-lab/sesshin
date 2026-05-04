import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRestServer, type RestServer } from './server.js';
import { SessionRegistry } from '../registry/session-registry.js';
import { ApprovalManager } from '../approval-manager.js';

let svr: RestServer; let port: number; let registry: SessionRegistry;
beforeEach(async () => {
  registry = new SessionRegistry();
  registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
  svr = createRestServer({ registry });
  await svr.listen(0, '127.0.0.1');
  port = svr.address().port;
});
afterEach(async () => { await svr.close(); });

describe('/hooks', () => {
  it('POST returns 204 for valid envelope', async () => {
    const body = { agent: 'claude-code', sessionId: 's1', ts: Date.now(), event: 'Stop', raw: { nativeEvent: 'Stop' } };
    const r = await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect(r.status).toBe(204);
  });
  it('POST 400 on malformed body', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(r.status).toBe(400);
  });
  it('POST 404 for unknown session', async () => {
    const body = { agent: 'claude-code', sessionId: 'missing', ts: 0, event: 'Stop', raw: {} };
    const r = await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect(r.status).toBe(404);
  });
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

describe('/hooks — stale cleanup', () => {
  let approvals: ApprovalManager;
  beforeEach(async () => {
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
      origin: 'permission', questions: [],
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
      origin: 'permission', questions: [],
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
      origin: 'permission', questions: [],
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
      origin: 'permission', questions: [],
    });
    await post('Stop', { nativeEvent: 'Stop' });
    await expect(decision).resolves.toMatchObject({ decision: 'deny' });
  });
  it('Stop does NOT singleton-resolve when 2+ pending entries', async () => {
    approvals.open({ sessionId: 's1', tool: 'Bash', toolInput: { command: 'ls' }, origin: 'permission', questions: [] });
    approvals.open({ sessionId: 's1', tool: 'Edit', toolInput: { file: 'x' }, origin: 'permission', questions: [] });
    await post('Stop', { nativeEvent: 'Stop' });
    expect(approvals.pendingForSession('s1')).toHaveLength(2);
  });
  it('PostToolUse without tool_use_id and 2 same-fingerprint entries → no cleanup', async () => {
    approvals.open({ sessionId: 's1', tool: 'Bash', toolInput: { command: 'ls' }, origin: 'permission', questions: [] });
    approvals.open({ sessionId: 's1', tool: 'Bash', toolInput: { command: 'ls' }, origin: 'permission', questions: [] });
    await post('PostToolUse', {
      nativeEvent: 'PostToolUse', tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    expect(approvals.pendingForSession('s1')).toHaveLength(2);
  });
  it('UserPromptSubmit (irrelevant event) does nothing', async () => {
    approvals.open({ sessionId: 's1', tool: 'Bash', toolInput: {}, toolUseId: 'tu_x', origin: 'permission', questions: [] });
    await post('UserPromptSubmit', { nativeEvent: 'UserPromptSubmit' });
    expect(approvals.pendingForSession('s1')).toHaveLength(1);
  });
});
