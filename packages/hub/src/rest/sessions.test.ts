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

describe('/api/sessions', () => {
  it('POST registers and returns id', async () => {
    const body = { id: 's1', name: 'claude (x)', agent: 'claude-code', cwd: '/x', pid: 99, sessionFilePath: '/p/s1.jsonl' };
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ id: 's1', registeredAt: expect.any(Number) });
    expect(registry.get('s1')).toBeDefined();
  });
  it('GET returns list snapshot', async () => {
    registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    expect(r.status).toBe(200);
    const list = await r.json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 's1', state: 'starting' });
  });
  it('DELETE removes', async () => {
    registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions/s1`, { method: 'DELETE' });
    expect(r.status).toBe(204);
    expect(registry.get('s1')).toBeUndefined();
  });
  it('POST with invalid body returns 400', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":"only"}',
    });
    expect(r.status).toBe(400);
  });
});

describe('heartbeat', () => {
  it('POST /api/sessions/:id/heartbeat updates lastHeartbeat', async () => {
    const before = Date.now();
    registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions/s1/heartbeat`, { method: 'POST' });
    expect(r.status).toBe(204);
    const rec = registry.get('s1');
    expect(rec!.lastHeartbeat).toBeGreaterThanOrEqual(before);
  });
  it('returns 404 for unknown session', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions/missing/heartbeat`, { method: 'POST' });
    expect(r.status).toBe(404);
  });
});
