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

  it('does NOT fire onLastActionsClientGone when decrementing a session whose count was never positive', async () => {
    // Trigger: a client subscribes 'all' (snapshot expanded against the registry at T0,
    // containing only s1). Then s2 is registered. Then the client sends `unsubscribe ['s2']`,
    // which causes bumpActions('s2', -1) — but s2 was never incremented for this client.
    // The previous guard (`delta === -1 && next <= 0`) fired spuriously because next went 0 → -1.
    // The fix requires `cur > 0` so the callback only fires on a true positive→zero transition.
    const gone: string[] = [];
    const registry = new SessionRegistry();
    registry.register({ id: 's1', name: 's1', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/tmp/s1' });
    const localSvr = createWsServer({
      registry,
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
        client: { kind: 'debug-web', version: '0.0.0', capabilities: ['actions','state'] },
      }));
      await new Promise<void>((res) => ws.once('message', () => res()));
      // Subscribe to 'all' — at this moment, registry has only s1, so s1's count → 1.
      ws.send(JSON.stringify({ type: 'subscribe', sessions: 'all', since: null }));
      await new Promise<void>((res) => setTimeout(res, 50));
      expect(localSvr.hasSubscribedActionsClient('s1')).toBe(true);
      expect(localSvr.hasSubscribedActionsClient('s2')).toBe(false);
      // Register a NEW session s2 *after* the client subscribed 'all'.
      registry.register({ id: 's2', name: 's2', agent: 'claude-code', cwd: '/', pid: 2, sessionFilePath: '/tmp/s2' });
      // s2 was never incremented for this client.
      expect(localSvr.hasSubscribedActionsClient('s2')).toBe(false);
      // Client unsubscribes s2. connection.ts (subscribed === 'all' branch) computes
      // remaining = all-but-s2, and decrements every session NOT in remaining → bumpActions('s2', -1).
      ws.send(JSON.stringify({ type: 'unsubscribe', sessions: ['s2'] }));
      await new Promise<void>((res) => setTimeout(res, 50));
      // Assert: callback was NOT fired for s2 (s2's count was 0, never positive).
      expect(gone).not.toContain('s2');
      expect(localSvr.hasSubscribedActionsClient('s2')).toBe(false);
      // s1 is still subscribed → no fire for s1 either.
      expect(gone).toEqual([]);
      expect(localSvr.hasSubscribedActionsClient('s1')).toBe(true);
      const closed = new Promise<void>((res) => ws.on('close', () => res()));
      ws.close();
      await closed;
    } finally {
      await localSvr.close();
    }
  });

  it('re-subscribing from "all" to specific list does not fire spuriously for sessions added after original subscribe', async () => {
    // Trigger: a client subscribes 'all' (registry contains only s1 at T0). Then s2 is
    // registered. Then the client RE-SUBSCRIBES to ['s1'] (not unsubscribe). The
    // subscribe-diff path computes prev = live registry = {s1, s2}, next = {s1},
    // producing a phantom bumpActions('s2', -1) for a count that was never positive.
    // The `cur > 0` guard in bumpActions must absorb this so onLastActionsClientGone
    // is NOT spuriously fired for s2.
    const gone: string[] = [];
    const registry = new SessionRegistry();
    registry.register({ id: 's1', name: 's1', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/tmp/s1' });
    const localSvr = createWsServer({
      registry,
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
        client: { kind: 'debug-web', version: '0.0.0', capabilities: ['actions','state'] },
      }));
      await new Promise<void>((res) => ws.once('message', () => res()));
      // Subscribe 'all' — registry only has s1, so s1's count → 1.
      ws.send(JSON.stringify({ type: 'subscribe', sessions: 'all', since: null }));
      await new Promise<void>((res) => setTimeout(res, 50));
      expect(localSvr.hasSubscribedActionsClient('s1')).toBe(true);
      expect(localSvr.hasSubscribedActionsClient('s2')).toBe(false);
      // Register s2 *after* the original 'all' subscribe — never incremented for this client.
      registry.register({ id: 's2', name: 's2', agent: 'claude-code', cwd: '/', pid: 2, sessionFilePath: '/tmp/s2' });
      expect(localSvr.hasSubscribedActionsClient('s2')).toBe(false);
      // Re-subscribe to ['s1'] specifically. connection.ts subscribe-diff:
      //   prev = live registry = {s1, s2}, next = {s1}
      //   → bumpActions('s2', -1)  (phantom decrement; guard must absorb)
      ws.send(JSON.stringify({ type: 'subscribe', sessions: ['s1'], since: null }));
      await new Promise<void>((res) => setTimeout(res, 50));
      // Assert: callback was NOT fired for s2 (s2's count was 0, never positive).
      expect(gone).not.toContain('s2');
      expect(gone).toEqual([]);
      // s1 remains subscribed.
      expect(localSvr.hasSubscribedActionsClient('s1')).toBe(true);
      expect(localSvr.hasSubscribedActionsClient('s2')).toBe(false);
      const closed = new Promise<void>((res) => ws.on('close', () => res()));
      ws.close();
      await closed;
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
