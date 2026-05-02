// packages/debug-web/src/ws-client.ts
import {
  connected, sessions, upsertSession, removeSession,
  addSummary, addEvent, appendRaw, lastEventId,
  addPromptRequest, removePromptRequest,
} from './store.js';
import type { Action } from '@sesshin/shared';

export interface PromptResponseAnswer {
  questionIndex: number;
  selectedKeys: string[];
  freeText?: string;
  notes?: string;
}

export interface WsClient {
  sendAction(sessionId: string, action: Action): void;
  sendText(sessionId: string, text: string): void;
  sendPromptResponse(sessionId: string, requestId: string, answers: PromptResponseAnswer[]): void;
  close(): void;
}

export function connect(): WsClient {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/v1/ws`;
  let ws: WebSocket | null = null;
  let backoff = 500;

  const open = (): void => {
    ws = new WebSocket(url);
    ws.addEventListener('open', () => {
      connected.value = true; backoff = 500;
      ws!.send(JSON.stringify({
        type: 'client.identify', protocol: 1,
        client: { kind: 'debug-web', version: '0.0.0',
          capabilities: ['summary','events','raw','actions','state','attention'] },
      }));
      ws!.send(JSON.stringify({ type: 'subscribe', sessions: 'all', since: lastEventId.value }));
    });
    ws.addEventListener('message', (e) => handleFrame(JSON.parse(e.data)));
    ws.addEventListener('close', () => { connected.value = false; setTimeout(open, backoff); backoff = Math.min(backoff * 2, 10_000); });
    ws.addEventListener('error', () => ws?.close());
  };
  open();

  return {
    sendAction(sessionId, action) { ws?.send(JSON.stringify({ type: 'input.action', sessionId, action })); },
    sendText(sessionId, text)     { ws?.send(JSON.stringify({ type: 'input.text', sessionId, text })); },
    sendPromptResponse(sessionId, requestId, answers) {
      ws?.send(JSON.stringify({ type: 'prompt-response', sessionId, requestId, answers }));
    },
    close() { ws?.close(); },
  };
}

function handleFrame(m: any): void {
  switch (m.type) {
    case 'server.hello': return;
    case 'server.ping': /* (server.pong handler if hub adds one in v1.5) */ return;
    case 'session.list':    sessions.value = m.sessions; return;
    case 'session.added':   upsertSession(m.session); return;
    case 'session.removed': removeSession(m.sessionId); return;
    case 'session.state':   {
      const cur = sessions.value.find((s) => s.id === m.sessionId);
      if (cur) upsertSession({ ...cur, state: m.state, substate: m.substate });
      return;
    }
    case 'session.summary': addSummary(m); return;
    case 'session.event':   addEvent(m); return;
    case 'session.raw':     appendRaw(m.sessionId, m.data); return;
    case 'session.prompt-request':
      addPromptRequest({
        sessionId: m.sessionId, requestId: m.requestId,
        origin: m.origin, toolName: m.toolName, toolUseId: m.toolUseId,
        body: m.body, questions: m.questions, expiresAt: m.expiresAt,
      }); return;
    case 'session.prompt-request.resolved':
      removePromptRequest(m.sessionId, m.requestId); return;
    // attention is accepted but not rendered yet (T64).
  }
}
