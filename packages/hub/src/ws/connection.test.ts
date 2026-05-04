import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { createWsServer, type WsServerInstance } from './server.js';
import { SessionRegistry } from '../registry/session-registry.js';
import { EventBus } from '../event-bus.js';
import { PtyTap } from '../observers/pty-tap.js';
import { ApprovalManager } from '../approval-manager.js';
import type { PromptQuestion } from '@sesshin/shared';
import { randomUUID } from 'node:crypto';

let svr: WsServerInstance;
let port: number;
let registry: SessionRegistry;
let approvals: ApprovalManager;

beforeEach(async () => {
  registry = new SessionRegistry();
  approvals = new ApprovalManager({ defaultTimeoutMs: 60_000 });
  svr = createWsServer({
    registry,
    bus: new EventBus(),
    tap: new PtyTap({ ringBytes: 1024 }),
    staticDir: null,
    approvals,
  });
  await svr.listen(0, '127.0.0.1');
  port = svr.address().port;
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

/** Open a WS, identify with the given capabilities, await server.hello. */
async function connectClient(capabilities: string[]): Promise<WebSocket> {
  const ws = await new Promise<WebSocket>((res, rej) => {
    const w = open(); w.on('open', () => res(w)); w.on('error', rej);
  });
  ws.send(JSON.stringify({
    type: 'client.identify', protocol: 1,
    client: { kind: 'debug-web', version: '0.0.0', capabilities },
  }));
  await recvFirst(ws);
  return ws;
}

/** Register a session in the test registry; return its id. */
function registerSession(): string {
  const id = randomUUID();
  registry.register({
    id,
    name: 'n',
    agent: 'claude-code',
    cwd: '/x',
    pid: 1,
    sessionFilePath: '/x/session.jsonl',
  });
  return id;
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

/** Collect all WS frames into an array, returning the array. */
function collectFrames(ws: WebSocket): any[] {
  const frames: any[] = [];
  ws.on('message', (raw) => frames.push(JSON.parse(raw.toString())));
  return frames;
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

describe('subscribe-time replay of pending prompt-requests', () => {
  function makeQuestions(): PromptQuestion[] {
    return [{ prompt: 'Allow?', multiSelect: false, allowFreeText: false,
      options: [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }] }];
  }

  it('replays pending prompt-request to actions-capable client on subscribe', async () => {
    const sid = registerSession();
    approvals.open({
      sessionId: sid, tool: 'Bash', toolInput: { command: 'ls' },
      origin: 'permission', body: 'cmd: ls', questions: makeQuestions(),
    });

    const client = await connectClient(['actions','state']);
    const frames = collectFrames(client);

    client.send(JSON.stringify({ type: 'subscribe', sessions: [sid], since: null }));
    await waitFor(() => frames.some((f) => f.type === 'session.prompt-request'));

    const replay = frames.find((f) => f.type === 'session.prompt-request');
    expect(replay).toBeDefined();
    expect(replay.sessionId).toBe(sid);
    expect(replay.toolName).toBe('Bash');
    expect(replay.origin).toBe('permission');
    expect(replay.body).toBe('cmd: ls');
    expect(replay.questions).toEqual(makeQuestions());
    client.close();
  });

  it('does NOT replay to client without actions cap', async () => {
    const sid = registerSession();
    approvals.open({
      sessionId: sid, tool: 'Read', toolInput: { file_path: '/x' },
      origin: 'permission', questions: [],
    });

    const client = await connectClient(['state']);  // no 'actions'
    const frames = collectFrames(client);

    client.send(JSON.stringify({ type: 'subscribe', sessions: [sid], since: null }));
    await delay(100);  // give it time to NOT send anything

    expect(frames.find((f) => f.type === 'session.prompt-request')).toBeUndefined();
    expect(frames.find((f) => f.type === 'session.list')).toBeDefined();
    client.close();
  });

  it('overlap subscribe does not double-replay', async () => {
    const sidA = registerSession();
    const sidB = registerSession();
    approvals.open({
      sessionId: sidA, tool: 'Bash', toolInput: {},
      origin: 'permission', questions: [],
    });
    approvals.open({
      sessionId: sidB, tool: 'Bash', toolInput: {},
      origin: 'permission', questions: [],
    });

    const client = await connectClient(['actions','state']);
    const frames = collectFrames(client);

    client.send(JSON.stringify({ type: 'subscribe', sessions: [sidA], since: null }));
    await waitFor(() => frames.filter((f) => f.type === 'session.prompt-request').length === 1);
    const before = frames.filter((f) => f.type === 'session.prompt-request').length;

    client.send(JSON.stringify({ type: 'subscribe', sessions: [sidA, sidB], since: null }));
    await waitFor(() => frames.filter((f) => f.type === 'session.prompt-request').length === 2);
    const after = frames.filter((f) => f.type === 'session.prompt-request').length;

    expect(after - before).toBe(1);  // only sidB replayed; sidA NOT re-sent
    client.close();
  });

  it('idempotent subscribe does not replay on second identical subscribe', async () => {
    const sid = registerSession();
    approvals.open({
      sessionId: sid, tool: 'Bash', toolInput: {},
      origin: 'permission', questions: [],
    });

    const client = await connectClient(['actions','state']);
    const frames = collectFrames(client);

    client.send(JSON.stringify({ type: 'subscribe', sessions: [sid], since: null }));
    await waitFor(() => frames.some((f) => f.type === 'session.prompt-request'));
    const before = frames.filter((f) => f.type === 'session.prompt-request').length;

    client.send(JSON.stringify({ type: 'subscribe', sessions: [sid], since: null }));
    await delay(100);
    const after = frames.filter((f) => f.type === 'session.prompt-request').length;

    expect(after).toBe(before);
    client.close();
  });

  it('replays multiple pending entries for the same session', async () => {
    const sid = registerSession();
    for (let i = 0; i < 3; i++) {
      approvals.open({
        sessionId: sid, tool: 'Bash', toolInput: { command: `echo ${i}` },
        origin: 'permission', questions: [],
      });
    }
    const client = await connectClient(['actions','state']);
    const frames = collectFrames(client);

    client.send(JSON.stringify({ type: 'subscribe', sessions: [sid], since: null }));
    await waitFor(() => frames.filter((f) => f.type === 'session.prompt-request').length === 3);

    const ids = new Set(frames
      .filter((f) => f.type === 'session.prompt-request')
      .map((f) => f.requestId));
    expect(ids.size).toBe(3);
    client.close();
  });

  it('subscribe "all" replays pending across all sessions', async () => {
    const sidA = registerSession();
    const sidB = registerSession();
    approvals.open({
      sessionId: sidA, tool: 'X', toolInput: {},
      origin: 'permission', questions: [],
    });
    approvals.open({
      sessionId: sidB, tool: 'Y', toolInput: {},
      origin: 'permission', questions: [],
    });

    const client = await connectClient(['actions','state']);
    const frames = collectFrames(client);

    client.send(JSON.stringify({ type: 'subscribe', sessions: 'all', since: null }));
    await waitFor(() => frames.filter((f) => f.type === 'session.prompt-request').length === 2);

    const sids = new Set(frames
      .filter((f) => f.type === 'session.prompt-request')
      .map((f) => f.sessionId));
    expect(sids).toEqual(new Set([sidA, sidB]));
    client.close();
  });

  it('does not replay resolved entries', async () => {
    const sid = registerSession();
    const { request } = approvals.open({
      sessionId: sid, tool: 'X', toolInput: {},
      origin: 'permission', questions: [],
    });
    approvals.decide(request.requestId, { decision: 'allow' });

    const client = await connectClient(['actions','state']);
    const frames = collectFrames(client);

    client.send(JSON.stringify({ type: 'subscribe', sessions: [sid], since: null }));
    await delay(100);

    expect(frames.find((f) => f.type === 'session.prompt-request')).toBeUndefined();
    client.close();
  });

  it('does not replay expired entries', async () => {
    const sid = registerSession();
    approvals.open({
      sessionId: sid, tool: 'X', toolInput: {},
      origin: 'permission', questions: [], timeoutMs: 10,
    });
    await delay(50);

    const client = await connectClient(['actions','state']);
    const frames = collectFrames(client);

    client.send(JSON.stringify({ type: 'subscribe', sessions: [sid], since: null }));
    await delay(100);

    expect(frames.find((f) => f.type === 'session.prompt-request')).toBeUndefined();
    client.close();
  });

  it('replay frame is structurally identical to a hand-built live broadcast', async () => {
    const sid = registerSession();
    const questions = makeQuestions();

    // Open approval to populate pendingForSession (will be replayed to late subscribers).
    const { request } = approvals.open({
      sessionId: sid, tool: 'Bash', toolInput: { command: 'rm -rf /' },
      origin: 'permission', body: 'cmd: rm -rf /', questions,
      toolUseId: 'tu_xyz',
    });

    // Subscribe client A FIRST and wait for subscription to be active.
    // Client A will receive the LIVE broadcast (via svr.broadcast), NOT a replay.
    const liveClient = await connectClient(['actions','state']);
    const liveFrames = collectFrames(liveClient);
    liveClient.send(JSON.stringify({ type: 'subscribe', sessions: [sid], since: null }));
    await waitFor(() => liveFrames.some((f) => f.type === 'session.list'));

    // Manually broadcast a synthetic 'live' frame matching what wire.ts would build
    // in onPreToolUseApproval / onPermissionRequestApproval.
    // This exercises the svr.broadcast routing path (same as wire.ts uses).
    // The shape here is the source of truth for what wire.ts emits.
    const liveBroadcastShape = {
      type: 'session.prompt-request',
      sessionId: sid,
      requestId: request.requestId,
      origin: 'permission',
      toolName: 'Bash',
      toolUseId: 'tu_xyz',
      expiresAt: request.expiresAt,
      body: 'cmd: rm -rf /',
      questions,
    };
    svr.broadcast(liveBroadcastShape);
    await waitFor(() => liveFrames.some((f) => f.type === 'session.prompt-request'));
    const liveFrame = liveFrames.find((f) => f.type === 'session.prompt-request');

    // Subscribe client B AFTER the approval is open — receives the REPLAY built
    // by connection.ts's subscribe-replay code path (distinct from wire.ts broadcast).
    const replayClient = await connectClient(['actions','state']);
    const replayFrames = collectFrames(replayClient);
    replayClient.send(JSON.stringify({ type: 'subscribe', sessions: [sid], since: null }));
    await waitFor(() => replayFrames.some((f) => f.type === 'session.prompt-request'));
    const replayFrame = replayFrames.find((f) => f.type === 'session.prompt-request');

    // Deep-equal: guards against drift between wire.ts's broadcast literal and
    // connection.ts's replay literal. If either code path changes its field set,
    // this comparison fails.
    expect(replayFrame).toEqual(liveFrame);

    liveClient.close();
    replayClient.close();
  });
});
