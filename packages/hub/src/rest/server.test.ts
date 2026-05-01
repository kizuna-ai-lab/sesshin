import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRestServer, type RestServer } from './server.js';
import { SessionRegistry } from '../registry/session-registry.js';

let svr: RestServer;
let port: number;
beforeEach(async () => {
  svr = createRestServer({ registry: new SessionRegistry() });
  await svr.listen(0, '127.0.0.1');
  port = svr.address().port;
});
afterEach(async () => { await svr.close(); });

describe('/api/health', () => {
  it('returns 200 with { ok: true } on GET', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });
  it('returns 405 on non-GET', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { method: 'POST' });
    expect(r.status).toBe(405);
  });
});
