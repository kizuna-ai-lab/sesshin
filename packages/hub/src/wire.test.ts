import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { createApprovalAdapters } from './wire.js';
import { createRestServer, type RestServer, type RestServerDeps } from './rest/server.js';
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
let onPreToolUseApproval: NonNullable<RestServerDeps['onPreToolUseApproval']> | undefined;

beforeEach(async () => {
  registry  = new SessionRegistry();
  // 1s timeout for this test; timeout tests will override as needed.
  approvals = new ApprovalManager({ defaultTimeoutMs: 1000 });

  let wsRef: WsServerInstance | undefined;
  const adapters = createApprovalAdapters({
    registry, approvals,
    approvalGate: parsePolicy('always'),  // force gate ON regardless of mode
    getWs: () => wsRef,
  });

  // Store the onPreToolUseApproval callback for use in tests.
  onPreToolUseApproval = adapters.restDeps.onPreToolUseApproval;

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

async function rebuildWithFastTimeout(timeoutMs = 30): Promise<void> {
  await rest.close();
  await ws.close();

  registry  = new SessionRegistry();
  approvals = new ApprovalManager({ defaultTimeoutMs: timeoutMs });
  let wsRef: WsServerInstance | undefined;
  const adapters = createApprovalAdapters({
    registry, approvals,
    approvalGate: parsePolicy('always'),
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

describe('wire.ts approval adapters — resolvedBy attribution', () => {
  it('decided → resolvedBy = remote-adapter:<clientKind>', async () => {
    const sid = registerSession();

    const client = await connectClient(['actions', 'state']);
    client.send(JSON.stringify({ type: 'subscribe', sessions: [sid], since: null }));
    // Give subscribe-time replay a beat to settle.
    await delay(50);

    // Trigger an approval via onPreToolUseApproval, which will populate
    // pendingHandlers and broadcast the session.prompt-request frame.
    const decisionPromise = onPreToolUseApproval?.({
      agent: 'claude-code',
      sessionId: sid,
      ts: Date.now(),
      event: 'PreToolUse',
      raw: {
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_use_id: randomUUID(),
      },
    }) ?? Promise.resolve(null);

    // Give the approval request a beat to broadcast.
    await delay(50);

    // Find the requestId of the prompt-request that was just broadcast.
    const promptFrame = broadcasts.find(
      (f): f is any =>
        (f as any).type === 'session.prompt-request'
        && (f as any).sessionId === sid,
    );
    expect(promptFrame).toBeDefined();
    const requestId = promptFrame!.requestId;

    // Now send the prompt-response
    client.send(JSON.stringify({
      type: 'prompt-response',
      sessionId: sid,
      requestId,
      answers: [{ questionIndex: 0, selectedKeys: ['yes'] }],
    }));

    await waitFor(() => findResolvedFrame(requestId) !== undefined);
    const frame = findResolvedFrame(requestId)!;
    expect(frame.reason).toBe('decided');
    expect(frame.resolvedBy).toBe('remote-adapter:debug-web');
    expect(frame.sessionId).toBe(sid);

    client.close();

    // Wait for the decision promise to settle so the test completes cleanly.
    await decisionPromise;
  });

  it('cancelled-tool-completed → resolvedBy = hub-stale-cleanup', async () => {
    const sid = registerSession();
    const { request } = approvals.open({
      sessionId: sid, tool: 'Bash', toolInput: { command: 'ls' },
      toolUseId: 'tu_stale', origin: 'permission', questions: [],
    });

    const r = await fetch(`http://127.0.0.1:${restPort}/hooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: 'claude-code', sessionId: sid, ts: Date.now(), event: 'PostToolUse',
        raw: {
          nativeEvent: 'PostToolUse', tool_name: 'Bash',
          tool_input: { command: 'ls' }, tool_use_id: 'tu_stale',
        },
      }),
    });
    expect(r.status).toBe(204);

    await waitFor(() => findResolvedFrame(request.requestId) !== undefined);
    const frame = findResolvedFrame(request.requestId)!;
    expect(frame.reason).toBe('cancelled-tool-completed');
    expect(frame.resolvedBy).toBe('hub-stale-cleanup');
    expect(frame.sessionId).toBe(sid);
  });

  it('timeout (PreToolUse) → resolvedBy = null', async () => {
    await rebuildWithFastTimeout();

    // ---- Now drive the test ----
    const sid = registerSession();

    // Don't await — the hook handler hangs until approval resolves
    // (decided / timeout / etc). We're testing the timeout path, so it
    // resolves via onExpire ~30ms later.
    const reqPromise = fetch(`http://127.0.0.1:${restPort}/hooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: 'claude-code', sessionId: sid, ts: Date.now(), event: 'PreToolUse',
        raw: {
          nativeEvent: 'PreToolUse', tool_name: 'Bash',
          tool_input: { command: 'ls' },
        },
      }),
    });

    // Wait for approvals.open to register a pending entry, then for the
    // timeout broadcast to fire.
    await waitFor(() => approvals.pendingForSession(sid).length === 1);
    const pending = approvals.pendingForSession(sid)[0]!;

    await waitFor(
      () => findResolvedFrame(pending.requestId) !== undefined,
      /* timeoutMs */ 500,
    );
    const frame = findResolvedFrame(pending.requestId)!;
    expect(frame.reason).toBe('timeout');
    expect(frame.resolvedBy).toBeNull();
    expect(frame.sessionId).toBe(sid);

    // Drain the hanging request — its body is the resulting decision.
    const r = await reqPromise;
    expect(r.status).toBe(200);
  });

  it('cancelled-no-clients → resolvedBy = null', async () => {
    const sid = registerSession();
    const { request } = approvals.open({
      sessionId: sid, tool: 'Bash', toolInput: { command: 'ls' },
      origin: 'permission', questions: [],
    });

    const client = await connectClient(['actions', 'state']);
    client.send(JSON.stringify({ type: 'subscribe', sessions: [sid], since: null }));
    // Wait until the WS server's actions-counter has registered the
    // subscription (so the close → counter-zero transition can fire).
    await waitFor(() => ws.hasSubscribedActionsClient(sid));

    // Closing the only actions-cap subscriber drops the per-session
    // actions count to zero → onLastActionsClientGone fires.
    client.close();

    await waitFor(() => findResolvedFrame(request.requestId) !== undefined);
    const frame = findResolvedFrame(request.requestId)!;
    expect(frame.reason).toBe('cancelled-no-clients');
    expect(frame.resolvedBy).toBeNull();
    expect(frame.sessionId).toBe(sid);
  });

  it('timeout (PermissionRequest) → resolvedBy = null', async () => {
    await rebuildWithFastTimeout();

    // ---- Drive the test ----
    const sid = registerSession();

    const reqPromise = fetch(`http://127.0.0.1:${restPort}/permission/${sid}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: 'claude-uuid', hook_event_name: 'PermissionRequest',
        tool_name: 'Bash', tool_input: { command: 'ls' },
        tool_use_id: 'tu_pr_timeout',
      }),
    });

    await waitFor(() => approvals.pendingForSession(sid).length === 1);
    const pending = approvals.pendingForSession(sid)[0]!;

    await waitFor(
      () => findResolvedFrame(pending.requestId) !== undefined,
      /* timeoutMs */ 500,
    );
    const frame = findResolvedFrame(pending.requestId)!;
    expect(frame.reason).toBe('timeout');
    expect(frame.resolvedBy).toBeNull();
    expect(frame.sessionId).toBe(sid);

    const r = await reqPromise;
    // Timeout resolves via 'ask' which onPermissionRequestApproval maps to null
    // (passthrough → 204). Some configs surface as 200; allow either.
    expect([200, 204]).toContain(r.status);
  });

  it('session-ended → resolvedBy = null', async () => {
    const sid = registerSession();
    const { request } = approvals.open({
      sessionId: sid, tool: 'Bash', toolInput: { command: 'ls' },
      origin: 'permission', questions: [],
    });

    registry.unregister(sid);

    await waitFor(() => findResolvedFrame(request.requestId) !== undefined);
    const frame = findResolvedFrame(request.requestId)!;
    expect(frame.reason).toBe('session-ended');
    expect(frame.resolvedBy).toBeNull();
    expect(frame.sessionId).toBe(sid);
  });
});
