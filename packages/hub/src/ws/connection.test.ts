import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { createWsServer, type WsServerInstance } from './server.js';
import { SessionRegistry } from '../registry/session-registry.js';
import { EventBus } from '../event-bus.js';
import { PtyTap } from '../observers/pty-tap.js';

let svr: WsServerInstance; let port: number;
beforeEach(async () => {
  svr = createWsServer({ registry: new SessionRegistry(), bus: new EventBus(), tap: new PtyTap({ ringBytes: 1024 }), staticDir: null });
  await svr.listen(0, '127.0.0.1'); port = svr.address().port;
});
afterEach(async () => { await svr.close(); });

function open(): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/v1/ws`);
}

function recvFirst(ws: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    ws.once('message', (m) => resolve(JSON.parse(m.toString())));
    ws.once('error', reject);
  });
}

describe('client.identify handshake', () => {
  it('responds with server.hello after valid client.identify', async () => {
    const ws = await new Promise<WebSocket>((res, rej) => {
      const w = open(); w.on('open', () => res(w)); w.on('error', rej);
    });
    ws.send(JSON.stringify({
      type: 'client.identify', protocol: 1,
      client: { kind: 'debug-web', version: '0.0.0', capabilities: ['summary','events','state'] },
    }));
    const reply = await recvFirst(ws);
    expect(reply.type).toBe('server.hello');
    expect(reply.protocol).toBe(1);
    ws.close();
  });
  it('closes 1002 if first frame is not client.identify', async () => {
    const ws = await new Promise<WebSocket>((res, rej) => {
      const w = open(); w.on('open', () => res(w)); w.on('error', rej);
    });
    const closed = new Promise<{ code: number }>((res) => ws.on('close', (code) => res({ code })));
    ws.send(JSON.stringify({ type: 'subscribe', sessions: 'all', since: null }));
    const r = await closed;
    expect(r.code).toBe(1002);
  });
  it('closes 1002 if client.identify is malformed', async () => {
    const ws = await new Promise<WebSocket>((res, rej) => {
      const w = open(); w.on('open', () => res(w)); w.on('error', rej);
    });
    const closed = new Promise<{ code: number }>((res) => ws.on('close', (code) => res({ code })));
    ws.send(JSON.stringify({ type: 'client.identify', protocol: 99 }));
    const r = await closed;
    expect(r.code).toBe(1002);
  });
});
