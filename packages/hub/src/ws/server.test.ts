import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { createWsServer, type WsServerInstance } from './server.js';
import { SessionRegistry } from '../registry/session-registry.js';
import { EventBus } from '../event-bus.js';
import { PtyTap } from '../observers/pty-tap.js';

let svr: WsServerInstance; let port: number;
beforeEach(async () => {
  svr = createWsServer({ registry: new SessionRegistry(), bus: new EventBus(), tap: new PtyTap({ ringBytes: 1024 }), staticDir: null });
  await svr.listen(0, '127.0.0.1');
  port = svr.address().port;
});
afterEach(async () => { await svr.close(); });

describe('WS server', () => {
  it('accepts a WS connection on /v1/ws', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve); ws.on('error', reject);
    });
    ws.close();
  });
  it('responds 426 when WS upgrade is missing on /v1/ws', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/ws`);
    expect(r.status).toBe(426);
  });
  it('returns 404 for HTTP paths when no static dir is configured', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/`);
    expect(r.status).toBe(404);
  });
});
