import type { WebSocket } from 'ws';
import type { WsServerDeps } from './server.js';

export function handleConnection(ws: WebSocket, _deps: WsServerDeps): void {
  // T35 fills in; for now just close on any message.
  ws.on('message', () => ws.close(1011, 'not yet implemented'));
}
