import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWsServer, type WsServerInstance } from './server.js';
import { SessionRegistry } from '../registry/session-registry.js';
import { EventBus } from '../event-bus.js';
import { PtyTap } from '../observers/pty-tap.js';
import { ApprovalManager } from '../approval-manager.js';
import { openDb, type Db } from '../storage/db.js';
import { Persistor } from '../storage/persistor.js';
import { LifecycleHandler } from '../lifecycle/handler.js';

interface Env {
  svr: WsServerInstance;
  port: number;
  registry: SessionRegistry;
  db: Db;
  persistor: Persistor;
  dir: string;
  signals: Array<[number, NodeJS.Signals | number]>;
  teardown: () => Promise<void>;
}

async function setup(): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), 'sesshin-ws-lc-'));
  const db = openDb(join(dir, 'state.db'));
  const registry = new SessionRegistry();
  const persistor = new Persistor({ db, registry, debounceMs: 5 });
  persistor.start();
  const signals: Env['signals'] = [];
  const lifecycle = new LifecycleHandler({
    registry, db, persistor,
    sendSignal: (pid, sig) => { signals.push([pid, sig]); return true; },
  });
  const svr = createWsServer({
    registry,
    bus: new EventBus(),
    tap: new PtyTap({ ringBytes: 1024 }),
    staticDir: null,
    approvals: new ApprovalManager({ defaultTimeoutMs: 60_000 }),
    lifecycle,
  });
  await svr.listen(0, '127.0.0.1');
  const port = svr.address().port;
  return {
    svr, port, registry, db, persistor, dir, signals,
    teardown: async () => {
      await svr.close();
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

describe('session.lifecycle WS handler', () => {
  let env: Env;
  beforeEach(async () => { env = await setup(); });
  afterEach(async () => { await env.teardown(); });

  it('returns server.error capability.required when client lacks lifecycle cap', async () => {
    env.registry.register({
      id: 's1', name: 'n', agent: 'claude-code', cwd: '/x',
      pid: 4242, sessionFilePath: '/x/session.jsonl',
    });
    env.registry.updateState('s1', 'idle');

    const client = await connectClient(env.port, ['state']);  // no 'lifecycle'
    const frames = collectFrames(client);

    client.send(JSON.stringify({
      type: 'session.lifecycle',
      requestId: 'r1',
      sessionId: 's1',
      action: 'pause',
    }));

    await waitFor(() => frames.some((f) => f.type === 'server.error'));
    const err = frames.find((f) => f.type === 'server.error');
    expect(err.code).toBe('capability.required');
    expect(err.message).toBe('lifecycle');
    expect(err.requestId).toBe('r1');
    expect(err.sessionId).toBe('s1');
    // No signal should have been delivered.
    expect(env.signals).toHaveLength(0);
    client.close();
  });

  it('invokes handler successfully when lifecycle cap present', async () => {
    env.registry.register({
      id: 's2', name: 'n', agent: 'claude-code', cwd: '/x',
      pid: 5151, sessionFilePath: '/x/session.jsonl',
    });
    env.registry.updateState('s2', 'idle');

    // proc-state is linux-only; on linux without a real process we'd see
    // 'gone'. Mock readProcState by leveraging that the handler trusts the
    // signal on non-linux platforms. So instead we just register a fake pid
    // and verify the WS path delivered the request to the handler — the
    // handler unit tests already cover the proc-state branch.
    const client = await connectClient(env.port, ['lifecycle', 'state']);
    const frames = collectFrames(client);

    client.send(JSON.stringify({
      type: 'session.lifecycle',
      requestId: 'r2',
      sessionId: 's2',
      action: 'rename',
      payload: { name: 'renamed' },
    }));

    // Rename has no proc-state branch, so it should succeed cleanly.
    await waitFor(() => env.registry.get('s2')?.name === 'renamed');
    expect(env.registry.get('s2')!.name).toBe('renamed');
    expect(env.db.sessions.get('s2')!.name).toBe('renamed');
    // Audit recorded with performedBy from client.kind ('debug-web').
    const audits = env.db.actions.list({ sessionId: 's2', limit: 10 });
    expect(audits.find((a) => a.kind === 'rename')).toBeDefined();
    expect(audits.find((a) => a.kind === 'rename')!.performedBy).toBe('debug-web');
    // No server.error frame should have been sent for a successful op.
    await delay(50);
    expect(frames.find((f) => f.type === 'server.error')).toBeUndefined();
    client.close();
  });

  it('emits server.error for handler rejection (invalid-state delete)', async () => {
    env.registry.register({
      id: 's3', name: 'n', agent: 'claude-code', cwd: '/x',
      pid: 6262, sessionFilePath: '/x/session.jsonl',
    });
    // delete is only valid in done/interrupted/killed; idle should reject.
    env.registry.updateState('s3', 'idle');

    const client = await connectClient(env.port, ['lifecycle']);
    const frames = collectFrames(client);

    client.send(JSON.stringify({
      type: 'session.lifecycle',
      requestId: 'r3',
      sessionId: 's3',
      action: 'delete',
    }));

    await waitFor(() => frames.some((f) => f.type === 'server.error'));
    const err = frames.find((f) => f.type === 'server.error');
    expect(err.code).toBe('lifecycle.invalid-state');
    expect(err.requestId).toBe('r3');
    expect(err.sessionId).toBe('s3');
    client.close();
  });
});
