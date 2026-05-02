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

describe('WS server hasSubscribedActionsClient + onLastActionsClientGone', () => {
  it('tracks actions-capable subscriptions and fires onLastActionsClientGone on close', async () => {
    const gone: string[] = [];
    const localSvr = createWsServer({
      registry: new SessionRegistry(),
      bus: new EventBus(),
      tap: new PtyTap({ ringBytes: 1024 }),
      staticDir: null,
      onLastActionsClientGone: (sid) => gone.push(sid),
    });
    await localSvr.listen(0, '127.0.0.1');
    const localPort = localSvr.address().port;
    try {
      expect(localSvr.hasSubscribedActionsClient('s1')).toBe(false);
      const ws = new WebSocket(`ws://127.0.0.1:${localPort}/v1/ws`);
      await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
      // identify with `actions` capability
      ws.send(JSON.stringify({
        type: 'client.identify', protocol: 1,
        client: { kind: 'debug-web', version: '0.0.0', capabilities: ['actions','state'] },
      }));
      // wait for server.hello
      await new Promise<void>((res) => ws.once('message', () => res()));
      // subscribe to s1, s2
      ws.send(JSON.stringify({ type: 'subscribe', sessions: ['s1','s2'], since: null }));
      // wait one tick for the message to be processed
      await new Promise<void>((res) => setTimeout(res, 50));
      expect(localSvr.hasSubscribedActionsClient('s1')).toBe(true);
      expect(localSvr.hasSubscribedActionsClient('s2')).toBe(true);
      expect(localSvr.hasSubscribedActionsClient('s3')).toBe(false);
      // Unsubscribe s2 → callback fires for s2 (last actions client gone)
      ws.send(JSON.stringify({ type: 'unsubscribe', sessions: ['s2'] }));
      await new Promise<void>((res) => setTimeout(res, 50));
      expect(gone).toContain('s2');
      expect(localSvr.hasSubscribedActionsClient('s2')).toBe(false);
      expect(localSvr.hasSubscribedActionsClient('s1')).toBe(true);
      // Close socket → s1 also fires
      const closed = new Promise<void>((res) => ws.on('close', () => res()));
      ws.close();
      await closed;
      await new Promise<void>((res) => setTimeout(res, 50));
      expect(gone).toContain('s1');
      expect(localSvr.hasSubscribedActionsClient('s1')).toBe(false);
    } finally {
      await localSvr.close();
    }
  });

  it('does NOT increment for clients without actions capability', async () => {
    const gone: string[] = [];
    const localSvr = createWsServer({
      registry: new SessionRegistry(),
      bus: new EventBus(),
      tap: new PtyTap({ ringBytes: 1024 }),
      staticDir: null,
      onLastActionsClientGone: (sid) => gone.push(sid),
    });
    await localSvr.listen(0, '127.0.0.1');
    const localPort = localSvr.address().port;
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${localPort}/v1/ws`);
      await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
      ws.send(JSON.stringify({
        type: 'client.identify', protocol: 1,
        client: { kind: 'debug-web', version: '0.0.0', capabilities: ['summary','events','state'] }, // no 'actions'
      }));
      await new Promise<void>((res) => ws.once('message', () => res()));
      ws.send(JSON.stringify({ type: 'subscribe', sessions: ['s1'], since: null }));
      await new Promise<void>((res) => setTimeout(res, 50));
      expect(localSvr.hasSubscribedActionsClient('s1')).toBe(false);
      const closed = new Promise<void>((res) => ws.on('close', () => res()));
      ws.close();
      await closed;
      await new Promise<void>((res) => setTimeout(res, 50));
      expect(gone).toEqual([]);
    } finally {
      await localSvr.close();
    }
  });
});
