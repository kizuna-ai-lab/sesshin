import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { createApprovalAdapters } from './wire.js';
import { createRestServer, type RestServer } from './rest/server.js';
import { createWsServer, type WsServerInstance } from './ws/server.js';
import { SessionRegistry } from './registry/session-registry.js';
import { ApprovalManager } from './approval-manager.js';
import { EventBus } from './event-bus.js';
import { PtyTap } from './observers/pty-tap.js';
import { parsePolicy } from './agents/claude/approval-policy.js';
import { randomUUID } from 'node:crypto';

// Tests in this file exercise wire.ts's broadcast wiring via the
// createApprovalAdapters factory. The WS server filters
// session.prompt-request.resolved by capability AND subscription, so for
// the cancelled-no-clients path no real client survives to observe the
// broadcast. We wrap ws.broadcast with a spy that captures every frame
// wire.ts intends to emit. Capability/subscription filtering is the WS
// server's concern and is covered separately in ws/connection.test.ts.

let registry: SessionRegistry;
let approvals: ApprovalManager;
let rest: RestServer;
let ws:   WsServerInstance;
let restPort: number;
let wsPort:   number;
let broadcasts: object[];

beforeEach(async () => {
  registry  = new SessionRegistry();
  // 50ms keeps the two timeout tests fast; matches the timer scale
  // already used in connection.test.ts:286,288.
  approvals = new ApprovalManager({ defaultTimeoutMs: 50 });

  let wsRef: WsServerInstance | undefined;
  const adapters = createApprovalAdapters({
    registry, approvals,
    approvalGate: parsePolicy('always'),  // force gate ON regardless of mode
    getWs: () => wsRef,
  });

  rest = createRestServer({ registry, approvals, ...adapters.restDeps });
  ws   = createWsServer({
    registry,
    bus:        new EventBus(),
    tap:        new PtyTap({ ringBytes: 1024 }),
    staticDir:  null,
    approvals,
    onInput:    async () => ({ ok: true }),
    ...adapters.wsDeps,
  });

  // Wrap broadcast with a spy. Captures every frame wire.ts emits even
  // when no client would receive it (capability/subscription filtered).
  broadcasts = [];
  const realBroadcast = ws.broadcast.bind(ws);
  ws.broadcast = (msg: object, filter?: (caps: string[]) => boolean): void => {
    broadcasts.push(msg);
    realBroadcast(msg, filter);
  };

  wsRef = ws;
  registry.on('session-removed', adapters.onSessionRemoved);

  await rest.listen(0, '127.0.0.1');
  await ws.listen(0, '127.0.0.1');
  restPort = rest.address().port;
  wsPort   = ws.address().port;
});

afterEach(async () => {
  await rest.close();
  await ws.close();
});

// ---- helpers (lifted verbatim from connection.test.ts pattern) ----

function openSocket(): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${wsPort}/v1/ws`);
}

function recvFirst(client: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    client.once('message', (m) => resolve(JSON.parse(m.toString())));
    client.once('error', reject);
  });
}

async function connectClient(capabilities: string[]): Promise<WebSocket> {
  const client = await new Promise<WebSocket>((res, rej) => {
    const w = openSocket(); w.on('open', () => res(w)); w.on('error', rej);
  });
  client.send(JSON.stringify({
    type: 'client.identify', protocol: 1,
    client: { kind: 'debug-web', version: '0.0.0', capabilities },
  }));
  await recvFirst(client);
  return client;
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

function registerSession(): string {
  const id = randomUUID();
  registry.register({
    id, name: 'n', agent: 'claude-code', cwd: '/x', pid: 1,
    sessionFilePath: '/x/session.jsonl',
  });
  return id;
}

interface ResolvedFrame {
  type: 'session.prompt-request.resolved';
  sessionId: string;
  requestId: string;
  reason:    string;
  resolvedBy: string | null;
}

function findResolvedFrame(reqId: string): ResolvedFrame | undefined {
  return broadcasts.find(
    (f): f is ResolvedFrame =>
      (f as any).type === 'session.prompt-request.resolved'
      && (f as any).requestId === reqId,
  );
}

// ---- tests ----

describe('createApprovalAdapters — factory contract shape', () => {
  it('returns restDeps, wsDeps, and onSessionRemoved with the expected keys', () => {
    let wsRef: WsServerInstance | undefined;
    const adapters = createApprovalAdapters({
      registry: new SessionRegistry(),
      approvals: new ApprovalManager({ defaultTimeoutMs: 1000 }),
      approvalGate: parsePolicy('always'),
      getWs: () => wsRef,
    });

    expect(Object.keys(adapters.restDeps).sort()).toEqual([
      'historyForSession',
      'onApprovalsCleanedUp',
      'onPermissionRequestApproval',
      'onPreToolUseApproval',
    ]);
    expect(Object.keys(adapters.wsDeps).sort()).toEqual([
      'onLastActionsClientGone',
      'onPromptResponse',
    ]);
    expect(typeof adapters.onSessionRemoved).toBe('function');
  });
});
