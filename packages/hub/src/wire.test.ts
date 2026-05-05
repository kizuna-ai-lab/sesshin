import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { createApprovalAdapters, createHookEventInterceptor } from './wire.js';
import { createRestServer, type RestServer } from './rest/server.js';
import { createWsServer, type WsServerInstance } from './ws/server.js';
import { SessionRegistry } from './registry/session-registry.js';
import { ApprovalManager } from './approval-manager.js';
import { EventBus } from './event-bus.js';
import { PtyTap } from './observers/pty-tap.js';
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
  // 1s timeout for this test; timeout tests will override as needed.
  approvals = new ApprovalManager({ defaultTimeoutMs: 1000 });

  let wsRef: WsServerInstance | undefined;
  const adapters = createApprovalAdapters({
    registry, approvals,
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

async function rebuildWithFastTimeout(timeoutMs = 30): Promise<void> {
  await rest.close();
  await ws.close();

  registry  = new SessionRegistry();
  approvals = new ApprovalManager({ defaultTimeoutMs: timeoutMs });
  let wsRef: WsServerInstance | undefined;
  const adapters = createApprovalAdapters({
    registry, approvals,
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
      getWs: () => wsRef,
    });

    expect(Object.keys(adapters.restDeps).sort()).toEqual([
      'historyForSession',
      'onApprovalsCleanedUp',
      'onPermissionRequestApproval',
    ]);
    expect(Object.keys(adapters.wsDeps).sort()).toEqual([
      'onLastActionsClientGone',
      'onPromptResponse',
    ]);
    expect(typeof adapters.onSessionRemoved).toBe('function');
    expect(typeof adapters.onClaudeSessionBoundary).toBe('function');
  });
});

describe('wire.ts approval adapters — resolvedBy attribution', () => {
  it('decided → resolvedBy = remote-adapter:<clientKind>', async () => {
    const sid = registerSession();

    const client = await connectClient(['actions', 'state']);
    client.send(JSON.stringify({ type: 'subscribe', sessions: [sid], since: null }));
    // Give subscribe-time replay a beat to settle.
    await delay(50);

    // Trigger an approval via the /permission/:sid HTTP route, which calls
    // onPermissionRequestApproval, populates pendingHandlers, and broadcasts
    // the session.prompt-request frame.
    const decisionPromise = fetch(`http://127.0.0.1:${restPort}/permission/${sid}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: 'claude-uuid', hook_event_name: 'PermissionRequest',
        tool_name: 'Bash', tool_input: { command: 'ls' },
        tool_use_id: randomUUID(),
      }),
    });

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

    // Drain the hanging request so the test completes cleanly.
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

// -----------------------------------------------------------------------------
// Phase B4: child Claude session boundary tests.
//
// These tests exercise createHookEventInterceptor — the wrapper around the
// wireHookIngest output that startHub uses in production. We don't need a
// real wireHookIngest here; we pass a stub `inner` to verify it is always
// called after boundary handling.
//
// Setup mirrors the createApprovalAdapters scaffold above so the same
// `broadcasts` capture works for both child-changed events (broadcast
// directly from the interceptor) and prompt-request.resolved events
// (broadcast via adapters.onClaudeSessionBoundary).
// -----------------------------------------------------------------------------

describe('child Claude session boundary (Phase B4)', () => {
  let innerCalls: object[];
  let onHookEvent: (env: { agent: string; sessionId: string; ts: number; event: string; raw: Record<string, unknown> }) => void;

  beforeEach(() => {
    innerCalls = [];
    // Re-derive adapters against the outer beforeEach's registry/approvals/ws
    // so we exercise the exact production cancel + broadcast shape rather
    // than reimplementing it in the test. The outer beforeEach already
    // installed adapters.onSessionRemoved on registry; we don't reinstall
    // anything from this freshly-derived set — we only borrow
    // onClaudeSessionBoundary.
    const adapters = createApprovalAdapters({
      registry, approvals, getWs: () => ws,
    });
    onHookEvent = createHookEventInterceptor({
      registry,
      getWs: () => ws,
      onClaudeSessionBoundary: adapters.onClaudeSessionBoundary,
      // No onTranscriptPathChanged in tests — we don't tail any files.
      inner: (env) => { innerCalls.push(env); },
    });
  });

  it('first SessionStart sets claudeSessionId from raw.session_id', () => {
    const sid = registerSession();
    onHookEvent({
      agent: 'claude-code', sessionId: sid, ts: 1, event: 'SessionStart',
      raw: { session_id: 'cc-1', source: 'startup', transcript_path: '/tmp/cc-1.jsonl' },
    });
    expect(registry.get(sid)?.claudeSessionId).toBe('cc-1');
    // child-changed broadcast fired
    const ev = broadcasts.find((b) => (b as any).type === 'session.child-changed');
    expect(ev).toMatchObject({
      sessionId: sid, previousClaudeSessionId: null,
      claudeSessionId: 'cc-1', reason: 'startup',
    });
    // inner handler was still called
    expect(innerCalls.length).toBe(1);
  });

  it('same raw.session_id on subsequent SessionStart does NOT broadcast child-changed', () => {
    const sid = registerSession();
    onHookEvent({
      agent: 'claude-code', sessionId: sid, ts: 1, event: 'SessionStart',
      raw: { session_id: 'cc-1', source: 'startup' },
    });
    const before = broadcasts.length;
    onHookEvent({
      agent: 'claude-code', sessionId: sid, ts: 2, event: 'SessionStart',
      raw: { session_id: 'cc-1', source: 'compact' },
    });
    expect(
      broadcasts.slice(before).find((b) => (b as any).type === 'session.child-changed'),
    ).toBeUndefined();
  });

  it('different raw.session_id triggers child-changed and resets child-scoped state', () => {
    const sid = registerSession();
    // Prime with cc-1.
    onHookEvent({
      agent: 'claude-code', sessionId: sid, ts: 1, event: 'SessionStart',
      raw: { session_id: 'cc-1', source: 'startup' },
    });
    // Dirty child-scoped state.
    registry.setFileCursor(sid, 500);
    registry.setLastSummary(sid, 'sum-1');
    expect(registry.get(sid)?.fileTailCursor).toBe(500);
    expect(registry.get(sid)?.lastSummaryId).toBe('sum-1');

    const before = broadcasts.length;
    onHookEvent({
      agent: 'claude-code', sessionId: sid, ts: 2, event: 'SessionStart',
      raw: { session_id: 'cc-2', source: 'clear' },
    });
    expect(registry.get(sid)?.claudeSessionId).toBe('cc-2');
    expect(registry.get(sid)?.fileTailCursor).toBe(0);
    expect(registry.get(sid)?.lastSummaryId).toBeNull();
    const ev = broadcasts.slice(before).find((b) => (b as any).type === 'session.child-changed');
    expect(ev).toMatchObject({
      sessionId: sid, previousClaudeSessionId: 'cc-1',
      claudeSessionId: 'cc-2', reason: 'clear',
    });
  });

  it.each([
    ['startup', 'startup'],
    ['clear',   'clear'],
    ['resume',  'resume'],
    ['compact', 'unknown'],   // unrecognized here (boundary should rarely fire on compact, but defensive)
    [undefined, 'unknown'],   // missing source
    ['nonsense','unknown'],   // unrecognized
  ])('reason mapping: raw.source=%j → reason=%s', (source, expected) => {
    const sid = registerSession();
    // Each sub-case needs a fresh registry record so the boundary fires.
    // Use a unique outgoing claude id so the equality check sees a change.
    const newCcId = `cc-${expected}-${Math.random()}`;
    const raw: Record<string, unknown> = { session_id: newCcId };
    if (source !== undefined) raw['source'] = source;
    onHookEvent({
      agent: 'claude-code', sessionId: sid, ts: 1, event: 'SessionStart', raw,
    });
    const ev = broadcasts.findLast((b) => (b as any).type === 'session.child-changed' && (b as any).sessionId === sid);
    expect(ev).toBeDefined();
    expect((ev as any).reason).toBe(expected);
  });

  it('SessionEnd clears claudeSessionId and broadcasts child-changed (reason=session-end)', () => {
    const sid = registerSession();
    onHookEvent({
      agent: 'claude-code', sessionId: sid, ts: 1, event: 'SessionStart',
      raw: { session_id: 'cc-2', source: 'startup' },
    });
    expect(registry.get(sid)?.claudeSessionId).toBe('cc-2');

    const before = broadcasts.length;
    onHookEvent({
      agent: 'claude-code', sessionId: sid, ts: 4, event: 'SessionEnd',
      raw: { session_id: 'cc-2' },
    });
    expect(registry.get(sid)?.claudeSessionId).toBeNull();
    const ev = broadcasts.slice(before).findLast(
      (b) => (b as any).type === 'session.child-changed',
    );
    expect(ev).toMatchObject({
      sessionId: sid, previousClaudeSessionId: 'cc-2',
      claudeSessionId: null, reason: 'session-end',
    });
  });

  it('SessionEnd when claudeSessionId is already null is a no-op (no broadcast)', () => {
    const sid = registerSession();   // fresh, no SessionStart yet
    const before = broadcasts.length;
    onHookEvent({
      agent: 'claude-code', sessionId: sid, ts: 5, event: 'SessionEnd', raw: {},
    });
    expect(
      broadcasts.slice(before).find((b) => (b as any).type === 'session.child-changed'),
    ).toBeUndefined();
  });

  it('boundary cancels pending approvals with reason=child-session-changed', () => {
    const sid = registerSession();
    // Prime with cc-1 so the next SessionStart triggers a real boundary.
    onHookEvent({
      agent: 'claude-code', sessionId: sid, ts: 1, event: 'SessionStart',
      raw: { session_id: 'cc-1', source: 'startup' },
    });
    // Open an approval under cc-1.
    const { request } = approvals.open({
      sessionId: sid, tool: 'Bash', toolInput: { command: 'ls' },
      origin: 'permission', questions: [],
    });
    expect(approvals.pendingForSession(sid).length).toBe(1);

    onHookEvent({
      agent: 'claude-code', sessionId: sid, ts: 2, event: 'SessionStart',
      raw: { session_id: 'cc-2', source: 'resume' },
    });

    expect(approvals.pendingForSession(sid).length).toBe(0);
    const resolved = findResolvedFrame(request.requestId);
    expect(resolved).toBeDefined();
    expect(resolved!.reason).toBe('child-session-changed');
    expect(resolved!.resolvedBy).toBeNull();
  });

  it('transcript-path fixup still runs alongside boundary detection', () => {
    const sid = registerSession();
    // Original sessionFilePath was '/x/session.jsonl' from registerSession.
    // Fire SessionStart with both new session_id AND new transcript_path.
    onHookEvent({
      agent: 'claude-code', sessionId: sid, ts: 1, event: 'SessionStart',
      raw: {
        session_id:      'cc-1',
        source:          'startup',
        transcript_path: '/tmp/new-transcript.jsonl',
      },
    });
    const rec = registry.get(sid);
    expect(rec?.claudeSessionId).toBe('cc-1');
    expect(rec?.sessionFilePath).toBe('/tmp/new-transcript.jsonl');
  });

  it('non-SessionStart / non-SessionEnd events are passed through without boundary work', () => {
    const sid = registerSession();
    const before = broadcasts.length;
    onHookEvent({
      agent: 'claude-code', sessionId: sid, ts: 1, event: 'PreToolUse',
      raw: { tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 'cc-x' },
    });
    expect(
      broadcasts.slice(before).find((b) => (b as any).type === 'session.child-changed'),
    ).toBeUndefined();
    expect(registry.get(sid)?.claudeSessionId).toBeNull();
    expect(innerCalls.length).toBe(1);
  });
});
