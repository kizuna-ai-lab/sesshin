import {
  connected, sessions, upsertSession, removeSession,
  addSummary, addEvent, lastEventId,
  addPromptRequest, removePromptRequest,
  applyConfigChanged, applyChildSessionChanged,
} from './store.js';
import type { Action, PromptResponseAnswer } from '@sesshin/shared';

export interface TerminalSnapshotMessage {
  type: 'terminal.snapshot';
  sessionId: string;
  seq: number;
  cols: number;
  rows: number;
  data: string;
}

export interface TerminalDeltaMessage {
  type: 'terminal.delta';
  sessionId: string;
  seq: number;
  data: string;
}

export interface TerminalResizeMessage {
  type: 'terminal.resize';
  sessionId: string;
  cols: number;
  rows: number;
}

export interface TerminalEndedMessage {
  type: 'terminal.ended';
  sessionId: string;
  reason?: string | null;
}

export type TerminalMessage =
  | TerminalSnapshotMessage
  | TerminalDeltaMessage
  | TerminalResizeMessage
  | TerminalEndedMessage;

export interface WsClient {
  sendAction(sessionId: string, action: Action): void;
  sendText(sessionId: string, text: string): void;
  sendPromptResponse(sessionId: string, requestId: string, answers: PromptResponseAnswer[]): void;
  subscribeTerminal(sessionId: string, onMessage: (message: TerminalMessage) => void): () => void;
  close(): void;
}

const terminalListeners = new Map<string, Set<(message: TerminalMessage) => void>>();
let currentSocket: WebSocket | null = null;

function sendFrame(payload: object): void {
  currentSocket?.send(JSON.stringify(payload));
}

function emitTerminal(message: TerminalMessage): void {
  const listeners = terminalListeners.get(message.sessionId);
  if (!listeners) return;
  for (const listener of listeners) listener(message);
}

function rehydrateTerminalSubscriptions(): void {
  for (const sessionId of terminalListeners.keys()) {
    sendFrame({ type: 'terminal.subscribe', sessionId });
  }
}

function handleTerminalFrame(m: any): boolean {
  if (m.type === 'terminal.snapshot' || m.type === 'terminal.delta' || m.type === 'terminal.resize' || m.type === 'terminal.ended') {
    emitTerminal(m as TerminalMessage);
    return true;
  }
  return false;
}

function handleFrame(m: any): void {
  if (handleTerminalFrame(m)) return;
  switch (m.type) {
    case 'server.hello': return;
    case 'server.ping': return;
    case 'session.list':    sessions.value = m.sessions; return;
    case 'session.added':   upsertSession(m.session); return;
    case 'session.removed': removeSession(m.sessionId); return;
    case 'session.state': {
      const cur = sessions.value.find((s) => s.id === m.sessionId);
      if (cur) upsertSession({ ...cur, state: m.state, substate: m.substate });
      return;
    }
    case 'session.summary': addSummary(m); return;
    case 'session.event':   addEvent(m); return;
    case 'session.prompt-request':
      addPromptRequest({
        sessionId: m.sessionId, requestId: m.requestId,
        origin: m.origin, toolName: m.toolName, toolUseId: m.toolUseId,
        body: m.body, questions: m.questions, expiresAt: m.expiresAt,
      }); return;
    case 'session.prompt-request.resolved':
      removePromptRequest(m.sessionId, m.requestId); return;
    case 'session.config-changed':
      applyConfigChanged(m.sessionId, {
        pin: m.pin,
        quietUntil: m.quietUntil,
        sessionGateOverride: m.sessionGateOverride,
      }); return;
    case 'session.child-changed':
      applyChildSessionChanged(m.sessionId, m.claudeSessionId);
      return;
  }
}

export function connect(): WsClient {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/v1/ws`;
  let ws: WebSocket | null = null;
  let backoff = 500;

  const open = (): void => {
    ws = new WebSocket(url);
    currentSocket = ws;
    ws.addEventListener('open', () => {
      connected.value = true;
      backoff = 500;
      ws!.send(JSON.stringify({
        type: 'client.identify', protocol: 1,
        client: { kind: 'debug-web', version: '0.0.0', capabilities: ['summary','events','terminal','actions','state','attention'] },
      }));
      ws!.send(JSON.stringify({ type: 'subscribe', sessions: 'all', since: lastEventId.value }));
      rehydrateTerminalSubscriptions();
    });
    ws.addEventListener('message', (e) => handleFrame(JSON.parse(e.data)));
    ws.addEventListener('close', () => {
      connected.value = false;
      currentSocket = null;
      setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 10_000);
    });
    ws.addEventListener('error', () => ws?.close());
  };
  open();

  return {
    sendAction(sessionId, action) { ws?.send(JSON.stringify({ type: 'input.action', sessionId, action })); },
    sendText(sessionId, text) { ws?.send(JSON.stringify({ type: 'input.text', sessionId, text })); },
    sendPromptResponse(sessionId, requestId, answers) {
      ws?.send(JSON.stringify({ type: 'prompt-response', sessionId, requestId, answers }));
    },
    subscribeTerminal(sessionId, onMessage) {
      let listeners = terminalListeners.get(sessionId);
      if (!listeners) {
        listeners = new Set();
        terminalListeners.set(sessionId, listeners);
      }
      listeners.add(onMessage);
      sendFrame({ type: 'terminal.subscribe', sessionId });
      return () => {
        const cur = terminalListeners.get(sessionId);
        if (!cur) return;
        cur.delete(onMessage);
        if (cur.size === 0) {
          terminalListeners.delete(sessionId);
          sendFrame({ type: 'terminal.unsubscribe', sessionId });
        }
      };
    },
    close() {
      ws?.close();
      currentSocket = null;
      terminalListeners.clear();
    },
  };
}
