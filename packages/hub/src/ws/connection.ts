import type { WebSocket } from 'ws';
import type { WsServerDeps } from './server.js';
import { ClientIdentifySchema, UpstreamMessageSchema, PROTOCOL_VERSION } from '@sesshin/shared';
import { hostname } from 'node:os';

export interface ConnectionState {
  ws: WebSocket;
  kind: string | null;
  capabilities: Set<string>;
  subscribedTo: Set<string> | 'all';
}

export interface BroadcastTarget {
  ws: WebSocket;
  caps(): Set<string>;
  subscribed(sessionId: string): boolean;
}

export function handleConnection(
  ws: WebSocket,
  deps: WsServerDeps,
  registerTarget: (target: BroadcastTarget) => void,
): void {
  const state: ConnectionState = { ws, kind: null, capabilities: new Set(), subscribedTo: new Set() };
  let identified = false;
  const identifyTimeout = setTimeout(() => {
    if (!identified) ws.close(1002, 'no client.identify within 5s');
  }, 5000);

  ws.on('close', () => clearTimeout(identifyTimeout));
  ws.on('message', (raw) => {
    let parsed: unknown;
    try { parsed = JSON.parse(raw.toString()); }
    catch { ws.close(1002, 'bad-frame'); return; }

    if (!identified) {
      const idResult = ClientIdentifySchema.safeParse(parsed);
      if (!idResult.success) { ws.close(1002, 'bad-identify'); return; }
      identified = true;
      clearTimeout(identifyTimeout);
      state.kind = idResult.data.client.kind;
      state.capabilities = new Set(idResult.data.client.capabilities);
      registerTarget({
        ws,
        caps: () => state.capabilities,
        subscribed: (sid) => state.subscribedTo === 'all' || state.subscribedTo.has(sid),
      });
      ws.send(JSON.stringify({
        type: 'server.hello', protocol: PROTOCOL_VERSION,
        machine: hostname(),
        supported: ['summary','events','raw','actions','voice','history','state','attention'],
      }));
      attachSubscribed(state, deps);
      return;
    }

    const upstream = UpstreamMessageSchema.safeParse(parsed);
    if (!upstream.success) {
      ws.send(JSON.stringify({ type: 'server.error', code: 'bad-frame' }));
      ws.close();
      return;
    }
    handleUpstream(state, upstream.data, deps);
  });
}

function attachSubscribed(state: ConnectionState, deps: WsServerDeps): void {
  const onAdded = (s: any): void => {
    if (!isSubscribed(state, s.id) || !state.capabilities.has('state')) return;
    state.ws.send(JSON.stringify({ type: 'session.added', session: s }));
  };
  const onRemoved = (id: string): void => {
    if (!isSubscribed(state, id) || !state.capabilities.has('state')) return;
    state.ws.send(JSON.stringify({ type: 'session.removed', sessionId: id }));
  };
  const onState = (s: any): void => {
    if (!isSubscribed(state, s.id) || !state.capabilities.has('state')) return;
    state.ws.send(JSON.stringify({ type: 'session.state', sessionId: s.id, state: s.state, substate: s.substate }));
  };
  deps.registry.on('session-added', onAdded);
  deps.registry.on('session-removed', onRemoved);
  deps.registry.on('state-changed', onState);
  deps.registry.on('substate-changed', onState);

  const onEvent = (e: any): void => {
    if (!isSubscribed(state, e.sessionId)) return;
    if (!state.capabilities.has('events')) return;
    state.ws.send(JSON.stringify({ type: 'session.event', ...e }));
  };
  deps.bus.on(onEvent);

  state.ws.on('close', () => {
    deps.registry.off('session-added', onAdded);
    deps.registry.off('session-removed', onRemoved);
    deps.registry.off('state-changed', onState);
    deps.registry.off('substate-changed', onState);
    deps.bus.off(onEvent);
  });
}

function isSubscribed(state: ConnectionState, sessionId: string): boolean {
  if (state.subscribedTo === 'all') return true;
  return state.subscribedTo.has(sessionId);
}

function handleUpstream(state: ConnectionState, msg: any, deps: WsServerDeps): void {
  if (msg.type === 'subscribe') {
    state.subscribedTo = msg.sessions === 'all' ? 'all' : new Set(msg.sessions);
    if (state.capabilities.has('state')) {
      state.ws.send(JSON.stringify({ type: 'session.list', sessions: deps.registry.list() }));
    }
    // (since-replay handled in T37.)
    return;
  }
  if (msg.type === 'unsubscribe') {
    if (state.subscribedTo === 'all') state.subscribedTo = new Set();
    else for (const id of msg.sessions) state.subscribedTo.delete(id);
    return;
  }
  // input.action / input.text — T38.
}
