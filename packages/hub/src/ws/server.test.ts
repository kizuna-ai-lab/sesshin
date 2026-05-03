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

  it('subscribe(all) increments NEW sessions on register; unsubscribe drops them cleanly', async () => {
    // Post Issue-2 fix: a client subscribed 'all' tracks sessions registered AFTER the
    // subscribe via the session-added listener. So when s2 is registered, s2's counter
    // goes 0→1 — and a subsequent `unsubscribe ['s2']` is now a real positive→zero
    // transition that legitimately fires onLastActionsClientGone for s2.
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
      await new Promise<void>((res) => setTimeout(res, 20));
      // s2 IS tracked thanks to the session-added listener.
      expect(localSvr.hasSubscribedActionsClient('s2')).toBe(true);
      // Client unsubscribes s2 → real positive→zero transition for s2.
      ws.send(JSON.stringify({ type: 'unsubscribe', sessions: ['s2'] }));
      await new Promise<void>((res) => setTimeout(res, 50));
      expect(gone).toContain('s2');
      expect(localSvr.hasSubscribedActionsClient('s2')).toBe(false);
      // s1 is still subscribed.
      expect(localSvr.hasSubscribedActionsClient('s1')).toBe(true);
      const closed = new Promise<void>((res) => ws.on('close', () => res()));
      ws.close();
      await closed;
    } finally {
      await localSvr.close();
    }
  });

  it('re-subscribing from "all" to specific list cleanly transitions counters for added-after sessions', async () => {
    // Post Issue-2 fix: subscribe 'all' attaches a session-added listener, so s2
    // (registered after the subscribe) is incremented to 1. Re-subscribing to ['s1']
    // detaches the listener and the subscribe-diff decrements s2 from 1→0, which is a
    // real positive→zero transition → onLastActionsClientGone fires for s2.
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
      // Register s2 *after* the original 'all' subscribe — listener increments to 1.
      registry.register({ id: 's2', name: 's2', agent: 'claude-code', cwd: '/', pid: 2, sessionFilePath: '/tmp/s2' });
      await new Promise<void>((res) => setTimeout(res, 20));
      expect(localSvr.hasSubscribedActionsClient('s2')).toBe(true);
      // Re-subscribe to ['s1'] specifically. prev = live registry = {s1, s2}, next = {s1}
      // → bumpActions('s2', -1) is a real 1→0 transition → callback fires for s2.
      ws.send(JSON.stringify({ type: 'subscribe', sessions: ['s1'], since: null }));
      await new Promise<void>((res) => setTimeout(res, 50));
      expect(gone).toContain('s2');
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

  it('bumpActions cur > 0 guard still absorbs phantom decrements (defense in depth)', async () => {
    // The cur > 0 guard in bumpActions is still useful for safety even after Issue 2:
    // if any future code path produces a stray bumpActions(-1) on a session whose
    // counter is already 0, the callback must not fire spuriously. We validate this
    // at the public surface: registering a session that no actions client tracks
    // must NOT fire onLastActionsClientGone (no decrement happens, so the guard's
    // role is implicit — but the invariant is the same: only fire on true 1→0).
    const gone: string[] = [];
    const registry = new SessionRegistry();
    const localSvr = createWsServer({
      registry,
      bus: new EventBus(),
      tap: new PtyTap({ ringBytes: 1024 }),
      staticDir: null,
      onLastActionsClientGone: (sid) => gone.push(sid),
    });
    await localSvr.listen(0, '127.0.0.1');
    try {
      // Register without any subscribed actions client → nobody tracks it, no fire.
      registry.register({ id: 'orphan', name: 'orphan', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/tmp/o' });
      await new Promise<void>((res) => setTimeout(res, 30));
      expect(gone).toEqual([]);
      expect(localSvr.hasSubscribedActionsClient('orphan')).toBe(false);
    } finally {
      await localSvr.close();
    }
  });

  it('subscribe(all) tracks NEW sessions registered after subscribe', async () => {
    // Regression: previously bumpActions(+1) fired only against the registry
    // snapshot at subscribe time, so a debug-web user (subscribes 'all') opening
    // BEFORE a sesshin session started would never get incremented for the new
    // session → its hasSubscribedActionsClient stayed false → PreToolUse hooks
    // would silently bypass the remote prompt.
    const gone: string[] = [];
    const registry = new SessionRegistry();
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
      // 1. Client subscribes 'all' before any sessions exist.
      const ws = new WebSocket(`ws://127.0.0.1:${localPort}/v1/ws`);
      await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
      ws.send(JSON.stringify({
        type: 'client.identify', protocol: 1,
        client: { kind: 'debug-web', version: '0.0.0', capabilities: ['actions','state'] },
      }));
      await new Promise<void>((res) => ws.once('message', () => res()));
      ws.send(JSON.stringify({ type: 'subscribe', sessions: 'all', since: null }));
      await new Promise<void>((res) => setTimeout(res, 50));
      // 2. hasSubscribedActionsClient('s1') is false (session doesn't exist yet).
      expect(localSvr.hasSubscribedActionsClient('s1')).toBe(false);
      // 3. Register 's1' AFTER the subscribe.
      registry.register({ id: 's1', name: 's1', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/tmp/s1' });
      await new Promise<void>((res) => setTimeout(res, 50));
      // 4. hasSubscribedActionsClient('s1') is now TRUE.
      expect(localSvr.hasSubscribedActionsClient('s1')).toBe(true);
      // 5. Disconnect client.
      const closed = new Promise<void>((res) => ws.on('close', () => res()));
      ws.close();
      await closed;
      await new Promise<void>((res) => setTimeout(res, 50));
      // 6. hasSubscribedActionsClient('s1') is now FALSE.
      expect(localSvr.hasSubscribedActionsClient('s1')).toBe(false);
      expect(gone).toContain('s1');
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

describe('input.action stop bypasses canAcceptInput running-state gate', () => {
  it('input.action stop is delivered to onInput even while session.state=running', async () => {
    const registry = new SessionRegistry();
    registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    registry.updateState('s1', 'running');

    const seenInput: Array<{ sid: string; data: string; source: string }> = [];
    const errs: Array<{ code?: string; message?: string }> = [];

    const localSvr = createWsServer({
      registry, bus: new EventBus(), tap: new PtyTap({ ringBytes: 1024 }), staticDir: null,
      onInput: async (sid, data, source) => {
        seenInput.push({ sid, data, source });
        return { ok: true };
      },
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
      await new Promise<void>((res) => ws.once('message', () => res()));   // server.hello

      ws.on('message', (buf) => {
        const m = JSON.parse(String(buf));
        if (m.type === 'server.error') errs.push(m);
      });

      // 1) During running: input.text 'hello\r' MUST be rejected (existing behavior — keep)
      ws.send(JSON.stringify({ type: 'input.text', sessionId: 's1', text: 'hello\r' }));
      await new Promise<void>((res) => setTimeout(res, 50));
      expect(errs.find((e) => e.code === 'input-rejected' && e.message === 'running')).toBeTruthy();

      // 2) During running: input.action stop MUST go through (the regression we just fixed)
      const errsBeforeStop = errs.length;
      ws.send(JSON.stringify({ type: 'input.action', sessionId: 's1', action: 'stop' }));
      await new Promise<void>((res) => setTimeout(res, 50));
      expect(errs.length).toBe(errsBeforeStop);                     // no new error
      const stopDelivered = seenInput.find((i) => i.data === '\x1b');
      expect(stopDelivered).toBeTruthy();
      expect(stopDelivered!.sid).toBe('s1');
      expect(stopDelivered!.source).toMatch(/^remote-adapter:/);

      ws.close();
    } finally {
      await localSvr.close();
    }
  });

  it('input.action stop still works in idle state (no regression)', async () => {
    const registry = new SessionRegistry();
    registry.register({ id: 's2', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    registry.updateState('s2', 'idle');

    const seenInput: string[] = [];
    const localSvr = createWsServer({
      registry, bus: new EventBus(), tap: new PtyTap({ ringBytes: 1024 }), staticDir: null,
      onInput: async (_sid, data) => { seenInput.push(data); return { ok: true }; },
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

      ws.send(JSON.stringify({ type: 'input.action', sessionId: 's2', action: 'stop' }));
      await new Promise<void>((res) => setTimeout(res, 50));
      expect(seenInput).toContain('\x1b');

      ws.close();
    } finally {
      await localSvr.close();
    }
  });
});
