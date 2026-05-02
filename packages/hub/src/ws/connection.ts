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

export function handleConnection(ws: WebSocket, deps: WsServerDeps): void {
  const state: ConnectionState = { ws, kind: null, capabilities: new Set(), subscribedTo: new Set() };
  let identified = false;
  const identifyTimeout = setTimeout(() => {
    if (!identified) ws.close(1002, 'no client.identify within 5s');
  }, 5000);

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
      ws.send(JSON.stringify({
        type: 'server.hello', protocol: PROTOCOL_VERSION,
        machine: hostname(),
        supported: ['summary','events','raw','actions','voice','history','state','attention'],
      }));
      // Future: T36 hooks subsequent message handling here.
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

  ws.on('close', () => clearTimeout(identifyTimeout));
}

// Stubs that T36/T38 fill in. Provided here so the file type-checks.
function attachSubscribed(_state: ConnectionState, _deps: WsServerDeps): void { /* T36 */ }
function handleUpstream(_state: ConnectionState, _msg: unknown, _deps: WsServerDeps): void { /* T36/T38 */ }
