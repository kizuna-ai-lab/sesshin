// T18: WS broadcasts (session.message / session.ended), history.request,
// and subscribe.includeEnded. These tests exercise the WS surface only —
// the storage and synthesizer layers each have their own units. The wiring
// that ties the synthesizer's broadcast callback to ws.broadcastSessionMessage
// lives in wire.ts; here we drive the helpers directly so the tests stay
// hub-focused.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from '@sesshin/shared';
import { createWsServer, type WsServerInstance } from './server.js';
import { SessionRegistry } from '../registry/session-registry.js';
import { EventBus } from '../event-bus.js';
import { PtyTap } from '../observers/pty-tap.js';
import { ApprovalManager } from '../approval-manager.js';
import { openDb, type Db, type MessageRow } from '../storage/db.js';
import { Persistor } from '../storage/persistor.js';
import { LifecycleHandler } from '../lifecycle/handler.js';
import { Synthesizer } from '../synthesizer/messages.js';

interface Env {
  svr: WsServerInstance;
  port: number;
  registry: SessionRegistry;
  bus: EventBus;
  db: Db;
  persistor: Persistor;
  lifecycle: LifecycleHandler;
  synth: Synthesizer;
  dir: string;
  teardown: () => Promise<void>;
}

async function setup(): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), 'sesshin-ws-msg-'));
  const db = openDb(join(dir, 'state.db'));
  const registry = new SessionRegistry();
  const bus = new EventBus();
  const persistor = new Persistor({ db, registry, debounceMs: 5 });
  // Wire the registry 'session-removed' broadcaster BEFORE persistor.start()
  // so it sees the pendingMark before persistor consumes it. Mirrors wire.ts.
  let svr: WsServerInstance | undefined;
  registry.on('session-removed', (id: string) => {
    const mark = persistor.getPendingMark(id);
    const endReason = (mark?.endReason ?? 'normal') as 'normal' | 'interrupted' | 'killed';
    svr?.broadcastSessionEnded({
      type: 'session.ended', sessionId: id, endedAt: Date.now(), endReason,
    });
  });
  persistor.start();
  const lifecycle = new LifecycleHandler({
    registry, db, persistor,
    sendSignal: () => true,
  });
  const synth = new Synthesizer({
    db, bus,
    broadcast: (m) => svr?.broadcastSessionMessage(m),
  });
  synth.start();
  svr = createWsServer({
    registry,
    bus,
    tap: new PtyTap({ ringBytes: 1024 }),
    staticDir: null,
    approvals: new ApprovalManager({ defaultTimeoutMs: 60_000 }),
    lifecycle,
    db,
  });
  await svr.listen(0, '127.0.0.1');
  const port = svr.address().port;
  return {
    svr, port, registry, bus, db, persistor, lifecycle, synth, dir,
    teardown: async () => {
      synth.stop();
      await svr!.close();
      persistor.stop();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function open(port: number): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/v1/ws`);
}

async function connectClient(port: number, capabilities: string[]): Promise<WebSocket> {
  const ws = await new Promise<WebSocket>((res, rej) => {
    const w = open(port); w.on('open', () => res(w)); w.on('error', rej);
  });
  ws.send(JSON.stringify({
    type: 'client.identify', protocol: 1,
    client: { kind: 'debug-web', version: '0.0.0', capabilities },
  }));
  await new Promise<void>((resolve, reject) => {
    ws.once('message', () => resolve());
    ws.once('error', reject);
  });
  return ws;
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await delay(10);
  }
}

function collectFrames(ws: WebSocket): any[] {
  const frames: any[] = [];
  ws.on('message', (raw) => frames.push(JSON.parse(raw.toString())));
  return frames;
}

function registerSession(env: Env, id: string): void {
  env.registry.register({
    id, name: 'n', agent: 'claude-code', cwd: '/x',
    pid: 1234, sessionFilePath: '/x/session.jsonl',
  });
}

describe('session.message broadcast', () => {
  let env: Env;
  beforeEach(async () => { env = await setup(); });
  afterEach(async () => { await env.teardown(); });

  it('reaches a subscriber with messages cap', async () => {
    const sid = 'sess-msg-1';
    registerSession(env, sid);

    const client = await connectClient(env.port, ['messages', 'state']);
    const frames = collectFrames(client);
    client.send(JSON.stringify({ type: 'subscribe', sessions: [sid], since: null }));
    await waitFor(() => frames.some((f) => f.type === 'session.list'));

    // Drive the synthesizer with a UserPromptSubmit. The synthesizer persists
    // a MessageRow and calls broadcast → ws.broadcastSessionMessage → client.
    env.bus.emit({
      eventId: 'e1', sessionId: sid, kind: 'user-prompt', source: 'observer:hook-ingest',
      ts: Date.now(), nativeEvent: 'UserPromptSubmit',
      payload: { prompt: 'hello' },
    } as never);

    await waitFor(() => frames.some((f) => f.type === 'session.message'));
    const msg = frames.find((f) => f.type === 'session.message');
    expect(msg.sessionId).toBe(sid);
    expect(msg.message.senderType).toBe('user');
    expect(msg.message.content).toBe('hello');
    expect(msg.message.requiresUserInput).toBe(false);
    client.close();
  });

  it('does NOT reach a subscriber without messages cap', async () => {
    const sid = 'sess-msg-2';
    registerSession(env, sid);

    const client = await connectClient(env.port, ['state']);  // no 'messages'
    const frames = collectFrames(client);
    client.send(JSON.stringify({ type: 'subscribe', sessions: [sid], since: null }));
    await waitFor(() => frames.some((f) => f.type === 'session.list'));

    env.bus.emit({
      eventId: 'e1', sessionId: sid, kind: 'user-prompt', source: 'observer:hook-ingest',
      ts: Date.now(), nativeEvent: 'UserPromptSubmit',
      payload: { prompt: 'hello' },
    } as never);

    await delay(80);
    expect(frames.find((f) => f.type === 'session.message')).toBeUndefined();
    client.close();
  });
});

describe('history.request', () => {
  let env: Env;
  beforeEach(async () => { env = await setup(); });
  afterEach(async () => { await env.teardown(); });

  it('returns persisted messages', async () => {
    const sid = 'sess-hist-1';
    registerSession(env, sid);
    // Append three messages via the same path the synthesizer uses.
    const rows: MessageRow[] = [
      { id: ulid(), sessionId: sid, senderType: 'user',  content: 'first',  format: 'text', requiresUserInput: false, createdAt: Date.now(),     sourceEventIds: [] },
      { id: ulid(), sessionId: sid, senderType: 'agent', content: 'second', format: 'text', requiresUserInput: false, createdAt: Date.now() + 1, sourceEventIds: [] },
      { id: ulid(), sessionId: sid, senderType: 'user',  content: 'third',  format: 'text', requiresUserInput: false, createdAt: Date.now() + 2, sourceEventIds: [] },
    ];
    for (const r of rows) env.db.messages.append(r);

    const client = await connectClient(env.port, ['messages']);
    const frames = collectFrames(client);

    client.send(JSON.stringify({
      type: 'history.request', requestId: 'r1',
      sessionId: sid, beforeId: null, limit: 10,
    }));

    await waitFor(() => frames.filter((f) => f.type === 'session.message').length === 3);
    const messages = frames.filter((f) => f.type === 'session.message');
    expect(messages.map((m) => m.message.content)).toEqual(['first', 'second', 'third']);
    expect(messages.every((m) => m.sessionId === sid)).toBe(true);
    client.close();
  });

  it('returns capability.required without messages cap', async () => {
    const sid = 'sess-hist-2';
    registerSession(env, sid);

    const client = await connectClient(env.port, ['state']);  // no 'messages'
    const frames = collectFrames(client);

    client.send(JSON.stringify({
      type: 'history.request', requestId: 'r2',
      sessionId: sid, beforeId: null, limit: 10,
    }));

    await waitFor(() => frames.some((f) => f.type === 'server.error'));
    const err = frames.find((f) => f.type === 'server.error');
    expect(err.code).toBe('capability.required');
    expect(err.message).toBe('messages');
    expect(err.requestId).toBe('r2');
    expect(err.sessionId).toBe(sid);
    expect(frames.find((f) => f.type === 'session.message')).toBeUndefined();
    client.close();
  });
});

describe('subscribe includeEnded', () => {
  let env: Env;
  beforeEach(async () => { env = await setup(); });
  afterEach(async () => { await env.teardown(); });

  it('returns ended sessions in the initial session.list', async () => {
    // Pre-populate an ended session in SQLite that's NOT in the live registry.
    env.db.sessions.upsert({
      id: 'sess-ended-1', name: 'old', agent: 'claude-code',
      cwd: '/old', pid: 999, sessionFilePath: '/old/session.jsonl',
      startedAt: Date.now() - 60_000, lastState: 'done',
      claudeSessionId: null,
      metadata: {},
    });
    env.db.sessions.markEnded('sess-ended-1', {
      endedAt: Date.now() - 30_000, endReason: 'normal', lastState: 'done',
    });

    // Register a live session for contrast.
    registerSession(env, 'sess-live-1');

    const client = await connectClient(env.port, ['state']);
    const frames = collectFrames(client);

    client.send(JSON.stringify({
      type: 'subscribe', sessions: 'all', since: null, includeEnded: true,
    }));

    await waitFor(() => frames.some((f) => f.type === 'session.list'));
    const list = frames.find((f) => f.type === 'session.list');
    const ids = (list.sessions as Array<{ id: string }>).map((s) => s.id);
    expect(ids).toContain('sess-live-1');
    expect(ids).toContain('sess-ended-1');
    // Ended session should carry endedAt / endReason from the row.
    const ended = list.sessions.find((s: { id: string }) => s.id === 'sess-ended-1');
    expect(ended.endedAt).not.toBeNull();
    expect(ended.endReason).toBe('normal');
    expect(ended.state).toBe('done');
    client.close();
  });

  it('omits ended sessions when includeEnded is false (default)', async () => {
    env.db.sessions.upsert({
      id: 'sess-ended-2', name: 'old', agent: 'claude-code',
      cwd: '/old', pid: 999, sessionFilePath: null,
      startedAt: Date.now() - 60_000, lastState: 'done',
      claudeSessionId: null,
      metadata: {},
    });
    env.db.sessions.markEnded('sess-ended-2', {
      endedAt: Date.now() - 30_000, endReason: 'normal', lastState: 'done',
    });
    registerSession(env, 'sess-live-2');

    const client = await connectClient(env.port, ['state']);
    const frames = collectFrames(client);

    client.send(JSON.stringify({ type: 'subscribe', sessions: 'all', since: null }));
    await waitFor(() => frames.some((f) => f.type === 'session.list'));
    const list = frames.find((f) => f.type === 'session.list');
    const ids = (list.sessions as Array<{ id: string }>).map((s) => s.id);
    expect(ids).toContain('sess-live-2');
    expect(ids).not.toContain('sess-ended-2');
    client.close();
  });
});

describe('session.ended broadcast', () => {
  let env: Env;
  beforeEach(async () => { env = await setup(); });
  afterEach(async () => { await env.teardown(); });

  it('reaches catalog-cap subscribers on lifecycle kill', async () => {
    const sid = 'sess-end-1';
    registerSession(env, sid);
    env.registry.updateState(sid, 'idle');

    const client = await connectClient(env.port, ['catalog', 'state']);
    const frames = collectFrames(client);
    client.send(JSON.stringify({ type: 'subscribe', sessions: [sid], since: null }));
    await waitFor(() => frames.some((f) => f.type === 'session.list'));

    // Drive a kill via the lifecycle handler. handle() runs the unregister
    // synchronously, which fires 'session-removed' on the registry. The wire
    // hook (registered in setup) reads the persistor's pending mark
    // (endReason='killed') and broadcasts session.ended to catalog clients.
    const result = env.lifecycle.handle({
      type: 'session.lifecycle', requestId: 'rk', sessionId: sid, action: 'kill',
    } as never, 'test');
    expect(result.ok).toBe(true);

    await waitFor(() => frames.some((f) => f.type === 'session.ended'));
    const ended = frames.find((f) => f.type === 'session.ended');
    expect(ended.sessionId).toBe(sid);
    expect(ended.endReason).toBe('killed');
    expect(typeof ended.endedAt).toBe('number');
    client.close();
  });

  it('does NOT reach a subscriber without catalog cap', async () => {
    const sid = 'sess-end-2';
    registerSession(env, sid);
    env.registry.updateState(sid, 'idle');

    const client = await connectClient(env.port, ['state']);  // no 'catalog'
    const frames = collectFrames(client);
    client.send(JSON.stringify({ type: 'subscribe', sessions: [sid], since: null }));
    await waitFor(() => frames.some((f) => f.type === 'session.list'));

    env.lifecycle.handle({
      type: 'session.lifecycle', requestId: 'rk', sessionId: sid, action: 'kill',
    } as never, 'test');

    await delay(80);
    expect(frames.find((f) => f.type === 'session.ended')).toBeUndefined();
    client.close();
  });
});
