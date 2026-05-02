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

  it('returns 503 when approvals dependency missing', async () => {
    const localRegistry = new SessionRegistry();
    const localSvr = createRestServer({ registry: localRegistry });
    await localSvr.listen(0, '127.0.0.1');
    const localPort = localSvr.address().port;
    try {
      const r = await fetch(`http://127.0.0.1:${localPort}/api/diagnostics`);
      expect(r.status).toBe(503);
    } finally {
      await localSvr.close();
    }
  });

  it('reflects pending approvals count', async () => {
    registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    approvals.open({ sessionId: 's1', tool: 'Bash', toolInput: { command: 'ls' }, timeoutMs: 60_000 });
    const r = await fetch(`http://127.0.0.1:${port}/api/diagnostics`);
    const j = await r.json();
    expect(j.sessions[0].pendingApprovals).toBe(1);
  });
});

describe('GET /api/sessions/:id/clients', () => {
  it('returns the listClients result', async () => {
    const localRegistry = new SessionRegistry();
    const localApprovals = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    const localSvr = createRestServer({
      registry: localRegistry,
      approvals: localApprovals,
      listClients: (sid) => [{ kind: 'cli-bridge', capabilities: ['actions','state'], subscribedTo: sid === 's1' ? ['s1'] : 'all' }],
    });
    await localSvr.listen(0, '127.0.0.1');
    const localPort = localSvr.address().port;
    try {
      const r = await fetch(`http://127.0.0.1:${localPort}/api/sessions/s1/clients`);
      expect(r.status).toBe(200);
      const j = await r.json();
      expect(j).toHaveLength(1);
      expect(j[0]).toMatchObject({ kind: 'cli-bridge', capabilities: ['actions','state'], subscribedTo: ['s1'] });
    } finally {
      await localSvr.close();
    }
  });

  it('rejects non-GET with 405', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions/s1/clients`, { method: 'POST' });
    expect(r.status).toBe(405);
  });
});

describe('GET /api/sessions/:id/history', () => {
  it('returns the historyForSession result', async () => {
    const localRegistry = new SessionRegistry();
    const localApprovals = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    const localSvr = createRestServer({
      registry: localRegistry,
      approvals: localApprovals,
      historyForSession: (sid, n) => [
        { requestId: 'r1', tool: 'Bash', resolvedAt: 1000, decision: 'allow' },
        { requestId: 'r2', tool: 'Read', resolvedAt: 2000, decision: 'deny', reason: 'no' },
      ].slice(0, n).filter(() => sid === 's1'),
    });
    await localSvr.listen(0, '127.0.0.1');
    const localPort = localSvr.address().port;
    try {
      const r = await fetch(`http://127.0.0.1:${localPort}/api/sessions/s1/history?n=10`);
      expect(r.status).toBe(200);
      const j = await r.json();
      expect(j).toHaveLength(2);
      expect(j[0].decision).toBe('allow');
      expect(j[1].reason).toBe('no');
    } finally {
      await localSvr.close();
    }
  });

  it('defaults n to 20 when not specified', async () => {
    let nReceived = -1;
    const localRegistry = new SessionRegistry();
    const localApprovals = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    const localSvr = createRestServer({
      registry: localRegistry,
      approvals: localApprovals,
      historyForSession: (_sid, n) => { nReceived = n; return []; },
    });
    await localSvr.listen(0, '127.0.0.1');
    const localPort = localSvr.address().port;
    try {
      await fetch(`http://127.0.0.1:${localPort}/api/sessions/s1/history`);
      expect(nReceived).toBe(20);
    } finally {
      await localSvr.close();
    }
  });

  it('clamps invalid n=… to default 20', async () => {
    let nReceived = -1;
    const localRegistry = new SessionRegistry();
    const localApprovals = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    const localSvr = createRestServer({
      registry: localRegistry,
      approvals: localApprovals,
      historyForSession: (_sid, n) => { nReceived = n; return []; },
    });
    await localSvr.listen(0, '127.0.0.1');
    const localPort = localSvr.address().port;
    try {
      await fetch(`http://127.0.0.1:${localPort}/api/sessions/s1/history?n=abc`);
      expect(nReceived).toBe(20);
    } finally {
      await localSvr.close();
    }
  });

  it('caps n=… at 100', async () => {
    let nReceived = -1;
    const localRegistry = new SessionRegistry();
    const localApprovals = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    const localSvr = createRestServer({
      registry: localRegistry,
      approvals: localApprovals,
      historyForSession: (_sid, n) => { nReceived = n; return []; },
    });
    await localSvr.listen(0, '127.0.0.1');
    const localPort = localSvr.address().port;
    try {
      await fetch(`http://127.0.0.1:${localPort}/api/sessions/s1/history?n=999`);
      expect(nReceived).toBe(100);
    } finally {
      await localSvr.close();
    }
  });

  it('returns history newest-first', async () => {
    const entries = [
      { requestId: 'r1', tool: 'Bash',     resolvedAt: 1000, decision: 'allow' as const },
      { requestId: 'r2', tool: 'Edit',     resolvedAt: 2000, decision: 'deny'  as const, reason: 'no' },
      { requestId: 'r3', tool: 'WebFetch', resolvedAt: 3000, decision: 'allow' as const },
    ];
    // Mock historyForSession to mimic the real store: returns last-N reversed.
    const newestFirst = (sid: string, n: number) => {
      void sid;
      return entries.slice(-n).reverse();
    };
    const localRegistry = new SessionRegistry();
    const localApprovals = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    const localSvr = createRestServer({
      registry: localRegistry,
      approvals: localApprovals,
      historyForSession: newestFirst,
    });
    await localSvr.listen(0, '127.0.0.1');
    const localPort = localSvr.address().port;
    try {
      const r = await fetch(`http://127.0.0.1:${localPort}/api/sessions/s1/history`);
      const j = await r.json();
      expect(j).toHaveLength(3);
      expect(j[0].requestId).toBe('r3');   // newest first
      expect(j[1].requestId).toBe('r2');
      expect(j[2].requestId).toBe('r1');
    } finally {
      await localSvr.close();
    }
  });
});

describe('mutating session endpoints', () => {
  it('POST /api/sessions/:id/trust adds the rule', async () => {
    registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions/s1/trust`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ruleString: 'Bash(git log:*)' }),
    });
    expect(r.status).toBe(204);
    expect(registry.get('s1')?.sessionAllowList).toEqual(['Bash(git log:*)']);
  });

  it('POST /api/sessions/:id/trust 400 when ruleString missing', async () => {
    registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions/s1/trust`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
  });

  it('POST /api/sessions/:id/trust 404 when session unknown', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions/nope/trust`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ruleString: 'Bash(ls:*)' }),
    });
    expect(r.status).toBe(404);
  });

  it('POST /api/sessions/:id/gate sets the override', async () => {
    registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions/s1/gate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ policy: 'always' }),
    });
    expect(r.status).toBe(204);
    expect(registry.getSessionGateOverride('s1')).toBe('always');
  });

  it('POST /api/sessions/:id/gate 400 on bad policy', async () => {
    registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions/s1/gate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ policy: 'bogus' }),
    });
    expect(r.status).toBe(400);
  });

  it('POST /api/sessions/:id/pin sets and clears the pin', async () => {
    registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const r1 = await fetch(`http://127.0.0.1:${port}/api/sessions/s1/pin`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'note me' }),
    });
    expect(r1.status).toBe(204);
    expect(registry.getPin('s1')).toBe('note me');
    const r2 = await fetch(`http://127.0.0.1:${port}/api/sessions/s1/pin`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: null }),
    });
    expect(r2.status).toBe(204);
    expect(registry.getPin('s1')).toBe(null);
  });

  it('POST /api/sessions/:id/pin with empty string clears the pin', async () => {
    registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    registry.setPin('s1', 'hello');
    expect(registry.get('s1')?.pin).toBe('hello');
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions/s1/pin`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '' }),
    });
    expect(r.status).toBe(204);
    expect(registry.get('s1')?.pin).toBeNull();
  });

  it('POST /api/sessions/:id/quiet sets and clears quietUntil', async () => {
    registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const before = Date.now();
    const r1 = await fetch(`http://127.0.0.1:${port}/api/sessions/s1/quiet`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ttlMs: 60_000 }),
    });
    expect(r1.status).toBe(204);
    const until = registry.getQuietUntil('s1');
    expect(until).not.toBeNull();
    expect(until!).toBeGreaterThanOrEqual(before + 60_000);
    expect(until!).toBeLessThan(before + 60_000 + 5_000);
    const r2 = await fetch(`http://127.0.0.1:${port}/api/sessions/s1/quiet`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ttlMs: 0 }),
    });
    expect(r2.status).toBe(204);
    expect(registry.getQuietUntil('s1')).toBe(null);
  });

  it('POST /api/sessions/:id/quiet 400 on negative ttl', async () => {
    registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions/s1/quiet`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ttlMs: -1 }),
    });
    expect(r.status).toBe(400);
  });

  it('rejects non-POST with 405 (gate)', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions/s1/gate`, { method: 'GET' });
    expect(r.status).toBe(405);
  });
});
