import type { WebSocket } from 'ws';
import type { WsServerDeps } from './server.js';
import { ClientIdentifySchema, UpstreamMessageSchema, PROTOCOL_VERSION } from '@sesshin/shared';
import { hostname } from 'node:os';
import { canAcceptInput } from '../input-arbiter.js';
import { actionToInput } from '../agents/claude/action-map.js';

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
  bumpActions: (sessionId: string, delta: 1 | -1) => void,
): void {
  const state: ConnectionState = { ws, kind: null, capabilities: new Set(), subscribedTo: new Set() };
  let identified = false;
  const identifyTimeout = setTimeout(() => {
    if (!identified) ws.close(1002, 'no client.identify within 5s');
  }, 5000);

  ws.on('close', () => clearTimeout(identifyTimeout));
  // On socket close, decrement the per-session actions counter for whatever
  // we were subscribed to (so the hub releases pending approvals waiting on
  // a now-departed client). Only relevant when this client had `actions` cap.
  ws.on('close', () => {
    if (!state.capabilities.has('actions')) return;
    // Live registry expansion (see subscribe-diff comment below): phantom decrements
    // for sessions registered after the original 'all' subscribe are absorbed by
    // bumpActions's cur > 0 guard.
    const cur = state.subscribedTo === 'all'
      ? deps.registry.list().map((s) => s.id)
      : Array.from(state.subscribedTo);
    for (const id of cur) bumpActions(id, -1);
  });
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
    handleUpstream(state, upstream.data, deps, bumpActions);
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

function handleUpstream(
  state: ConnectionState,
  msg: any,
  deps: WsServerDeps,
  bumpActions: (sessionId: string, delta: 1 | -1) => void,
): void {
  if (msg.type === 'subscribe') {
    // Diff prev vs next subscription set, bumping the per-session
    // actions-counter only for clients that have the `actions` capability.
    // This is what powers `hasSubscribedActionsClient` and lets the hub know
    // when the last subscribed client just left a session.
    const hasActions = state.capabilities.has('actions');
    const next = msg.sessions === 'all'
      ? new Set(deps.registry.list().map((s) => s.id))
      : new Set<string>(msg.sessions);
    if (hasActions) {
      // NB: when state.subscribedTo === 'all', prev is the LIVE registry at re-subscribe
      // time, not the snapshot at original subscribe time. Sessions registered AFTER the
      // 'all' subscribe will appear in prev without ever having been incremented for this
      // client; the resulting phantom -1 decrements are absorbed by bumpActions's
      // `cur > 0` guard. Same caveat applies to the unsubscribe 'all' branch and close.
      const prev = state.subscribedTo === 'all'
        ? new Set(deps.registry.list().map((s) => s.id))
        : state.subscribedTo;
      for (const id of next) if (!prev.has(id)) bumpActions(id, 1);
      for (const id of prev) if (!next.has(id)) bumpActions(id, -1);
    }
    state.subscribedTo = msg.sessions === 'all' ? 'all' : new Set(msg.sessions);
    if (state.capabilities.has('state')) {
      state.ws.send(JSON.stringify({ type: 'session.list', sessions: deps.registry.list() }));
    }
    if (msg.since && state.capabilities.has('events')) {
      const sids = state.subscribedTo === 'all' ? deps.registry.list().map((s) => s.id) : Array.from(state.subscribedTo);
      for (const sid of sids) {
        for (const e of deps.bus.eventsSince(sid, msg.since)) {
          state.ws.send(JSON.stringify({ type: 'session.event', ...e }));
        }
      }
    }
    return;
  }
  if (msg.type === 'unsubscribe') {
    const hasActions = state.capabilities.has('actions');
    if (state.subscribedTo === 'all') {
      // Was subscribed to everything; now drop the explicit sessions. For
      // an `actions` client this means decrementing every session NOT in
      // the unsubscribe list (because everything else stays subscribed).
      // Practically clients use 'all' rarely so we just snapshot now.
      const all = new Set(deps.registry.list().map((s) => s.id));
      const drop = new Set<string>(msg.sessions);
      const remaining = new Set<string>();
      for (const id of all) if (!drop.has(id)) remaining.add(id);
      if (hasActions) {
        for (const id of all) if (!remaining.has(id)) bumpActions(id, -1);
      }
      state.subscribedTo = remaining;
    } else {
      for (const id of msg.sessions) {
        if (state.subscribedTo.has(id)) {
          state.subscribedTo.delete(id);
          if (hasActions) bumpActions(id, -1);
        }
      }
    }
    return;
  }
  if (msg.type === 'prompt-response') {
    const ok = deps.onPromptResponse?.(msg.sessionId, msg.requestId, msg.answers) ?? false;
    if (!ok) state.ws.send(JSON.stringify({ type: 'server.error', code: 'prompt-stale', message: 'no pending prompt-request for that requestId' }));
    return;
  }
  if (msg.type === 'input.action' || msg.type === 'input.text') {
    const session = deps.registry.get(msg.sessionId);
    if (!session) {
      state.ws.send(JSON.stringify({ type: 'server.error', code: 'input-rejected', message: 'session-offline' }));
      return;
    }
    const source = `remote-adapter:${state.kind ?? 'unknown'}` as const;
    const decision = canAcceptInput(session.state, source);
    if (!decision.ok) {
      state.ws.send(JSON.stringify({ type: 'server.error', code: 'input-rejected', message: decision.reason }));
      return;
    }
    let data: string | null = null;
    if (msg.type === 'input.text') data = msg.text;
    else if (session.agent === 'claude-code') data = actionToInput(msg.action);
    if (!data) {
      state.ws.send(JSON.stringify({ type: 'server.error', code: 'unsupported-action' }));
      return;
    }
    deps.onInput?.(msg.sessionId, data, source).catch(() => {});
    return;
  }
}
