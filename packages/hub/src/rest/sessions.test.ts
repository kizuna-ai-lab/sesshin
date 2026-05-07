import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRestServer, type RestServer } from './server.js';
import { SessionRegistry } from '../registry/session-registry.js';

let svr: RestServer; let port: number; let registry: SessionRegistry;
beforeEach(async () => {
  registry = new SessionRegistry();
  svr = createRestServer({ registry });
  await svr.listen(0, '127.0.0.1');
  port = svr.address().port;
});
afterEach(async () => { await svr.close(); });

describe('/api/v1/sessions', () => {
  it('POST registers and returns id', async () => {
    const body = { id: 's1', name: 'claude (x)', agent: 'claude-code', cwd: '/x', pid: 99, sessionFilePath: '/p/s1.jsonl' };
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ id: 's1', registeredAt: expect.any(Number) });
    expect(registry.get('s1')).toBeDefined();
  });
  it('GET returns list snapshot', async () => {
    registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/sessions`);
    expect(r.status).toBe(200);
    const list = await r.json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 's1', state: 'starting' });
  });
  it('DELETE removes', async () => {
    registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/s1`, { method: 'DELETE' });
    expect(r.status).toBe(204);
    expect(registry.get('s1')).toBeUndefined();
  });
  it('POST with invalid body returns 400', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":"only"}',
    });
    expect(r.status).toBe(400);
  });
  it('accepts initialPermissionMode in register body', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'sNew', name: 'n', agent: 'claude-code', cwd: '/', pid: 99,
        sessionFilePath: '/x.jsonl',
        initialPermissionMode: 'auto',
      }),
    });
    expect(r.status).toBe(201);
    const list = await (await fetch(`http://127.0.0.1:${port}/api/v1/sessions`)).json();
    expect(list.find((s: any) => s.id === 'sNew')?.substate.permissionMode).toBe('auto');
  });
});

describe('GET /api/v1/sessions/:id', () => {
  it('returns 200 + { id } when session is registered', async () => {
    registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/s1`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id: 's1' });
  });
  it('returns 404 when session is unknown', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/missing`);
    expect(r.status).toBe(404);
  });
  it('still returns 405 for unsupported methods (e.g. PUT)', async () => {
    registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/s1`, { method: 'PUT' });
    expect(r.status).toBe(405);
  });
});

describe('/api/v1/sessions/:id/banner-debug', () => {
  it('returns the diagnostic when inspectBanner is wired', async () => {
    registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const inspectBanner = (id: string): unknown => ({ sessionId: id, detectedMode: 'plan', viewportRows: [] });
    const localSvr = createRestServer({ registry, inspectBanner });
    await localSvr.listen(0, '127.0.0.1');
    const localPort = localSvr.address().port;
    try {
      const r = await fetch(`http://127.0.0.1:${localPort}/api/v1/sessions/s1/banner-debug`);
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body).toMatchObject({ sessionId: 's1', detectedMode: 'plan' });
    } finally {
      await localSvr.close();
    }
  });
  it('returns 501 when inspectBanner is not wired', async () => {
    registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/s1/banner-debug`);
    expect(r.status).toBe(501);
  });
  it('returns 404 with session-not-registered for unknown session', async () => {
    const inspectBanner = (): unknown => ({});
    const localSvr = createRestServer({ registry, inspectBanner });
    await localSvr.listen(0, '127.0.0.1');
    const localPort = localSvr.address().port;
    try {
      const r = await fetch(`http://127.0.0.1:${localPort}/api/v1/sessions/missing/banner-debug`);
      expect(r.status).toBe(404);
      expect(await r.json()).toMatchObject({ error: 'session-not-registered' });
    } finally {
      await localSvr.close();
    }
  });
  it('returns 409 with tracker-not-attached when session exists but inspector returns null', async () => {
    registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const inspectBanner = (_id: string): unknown => null;
    const localSvr = createRestServer({ registry, inspectBanner });
    await localSvr.listen(0, '127.0.0.1');
    const localPort = localSvr.address().port;
    try {
      const r = await fetch(`http://127.0.0.1:${localPort}/api/v1/sessions/s1/banner-debug`);
      expect(r.status).toBe(409);
      expect(await r.json()).toMatchObject({ error: 'tracker-not-attached' });
    } finally {
      await localSvr.close();
    }
  });
});

describe('heartbeat', () => {
  it('POST /api/v1/sessions/:id/heartbeat updates lastHeartbeat', async () => {
    const before = Date.now();
    registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/s1/heartbeat`, { method: 'POST' });
    expect(r.status).toBe(204);
    const rec = registry.get('s1');
    expect(rec!.lastHeartbeat).toBeGreaterThanOrEqual(before);
  });
  it('returns 404 for unknown session', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/missing/heartbeat`, { method: 'POST' });
    expect(r.status).toBe(404);
  });
});

describe('/api/v1/sessions/:id/raw', () => {
  it('writes received bytes into the PtyTap', async () => {
    const { PtyTap } = await import('../observers/pty-tap.js');
    const tap = new PtyTap({ ringBytes: 1024 });
    const localRegistry = new SessionRegistry();
    localRegistry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const localSvr = createRestServer({ registry: localRegistry, tap });
    await localSvr.listen(0, '127.0.0.1');
    const localPort = localSvr.address().port;
    const r = await fetch(`http://127.0.0.1:${localPort}/api/v1/sessions/s1/raw`, { method: 'POST', body: 'hello' });
    expect(r.status).toBe(204);
    expect(tap.snapshot('s1').toString('utf-8')).toBe('hello');
    await localSvr.close();
  });
});
