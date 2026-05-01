import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRestServer, type RestServer } from './server.js';
import { SessionRegistry } from '../registry/session-registry.js';

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
});
