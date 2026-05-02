import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, normalize, resolve, extname } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { SessionRegistry } from '../registry/session-registry.js';
import type { EventBus } from '../event-bus.js';
import type { PtyTap } from '../observers/pty-tap.js';
import { handleConnection, type BroadcastTarget } from './connection.js';

export interface WsServerDeps {
  registry: SessionRegistry;
  bus:      EventBus;
  tap:      PtyTap;
  staticDir: string | null;
  /** Called when a WS client sends an input.action or input.text. Wired in T38. */
  onInput?: (sessionId: string, data: string, source: string) => Promise<{ ok: boolean; reason?: string }>;
  /**
   * Called when a client posts a prompt-response for a pending
   * session.prompt-request. Returns whether a matching pending request was
   * found (false → stale or already resolved by another client/timeout).
   */
  onPromptResponse?: (sessionId: string, requestId: string, answers: import('@sesshin/shared').PromptResponse['answers']) => boolean;
  /**
   * Called when the last `actions`-capable client subscribed to `sessionId`
   * disconnects (or unsubscribes). Sesshin uses this to release any pending
   * approval long-polls back to claude's TUI so the laptop doesn't sit
   * blocked on an absent remote.
   */
  onLastActionsClientGone?: (sessionId: string) => void;
}

export interface WsServerInstance {
  listen(port: number, host: string): Promise<void>;
  close(): Promise<void>;
  address(): AddressInfo;
  broadcast(msg: object, filter?: (clientCaps: string[]) => boolean): void;
  /** True iff ≥1 connected client has the `actions` capability AND is currently subscribed to this session. */
  hasSubscribedActionsClient(sessionId: string): boolean;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico':  'image/x-icon',
};

function capabilityRequiredFor(msgType: string): string | null {
  switch (msgType) {
    case 'session.summary':              return 'summary';
    case 'session.raw':                  return 'raw';
    case 'session.event':                return 'events';
    case 'session.attention':            return 'attention';
    case 'session.prompt-request':
    case 'session.prompt-request.resolved': return 'actions';
    case 'session.state':
    case 'session.list':
    case 'session.added':
    case 'session.removed':              return 'state';
    default:                             return null;
  }
}

export function createWsServer(deps: WsServerDeps): WsServerInstance {
  const http = createServer((req, res) => serveHttp(req, res, deps));
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();
  const targets = new Map<WebSocket, BroadcastTarget>();
  // Counter map: sessionId → number of currently-connected `actions`-capable
  // clients subscribed to that session. Maintained by `bumpActions` below
  // (called from connection.ts on subscribe/unsubscribe/close events).
  const actionsBySession = new Map<string, number>();
  function bumpActions(sessionId: string, delta: 1 | -1): void {
    const cur = actionsBySession.get(sessionId) ?? 0;
    const next = cur + delta;
    if (next <= 0) actionsBySession.delete(sessionId);
    else actionsBySession.set(sessionId, next);
    if (delta === -1 && next <= 0) deps.onLastActionsClientGone?.(sessionId);
  }

  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/v1/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on('close', () => { sockets.delete(ws); targets.delete(ws); });
      handleConnection(ws, deps, (target) => targets.set(ws, target), bumpActions);
    });
  });

  return {
    listen: (port, host) => new Promise((resolve, reject) => {
      http.once('error', reject);
      http.listen(port, host, () => { http.off('error', reject); resolve(); });
    }),
    close: () => new Promise((resolve) => {
      for (const ws of sockets) ws.terminate();
      wss.close(() => http.close(() => resolve()));
    }),
    address: () => http.address() as AddressInfo,
    broadcast: (msg) => {
      const data = JSON.stringify(msg);
      const requiredCap = capabilityRequiredFor((msg as any).type);
      const sessionId = (msg as any).sessionId as string | undefined;
      for (const [ws, target] of targets) {
        if ((ws as unknown as { readyState: number }).readyState !== 1) continue;
        if (requiredCap && !target.caps().has(requiredCap)) continue;
        if (sessionId && !target.subscribed(sessionId)) continue;
        ws.send(data);
      }
    },
    hasSubscribedActionsClient: (sid) => (actionsBySession.get(sid) ?? 0) > 0,
  };
}

function serveHttp(req: IncomingMessage, res: ServerResponse, deps: WsServerDeps): void {
  if ((req.url ?? '').startsWith('/v1/ws')) return void res.writeHead(426).end('Upgrade Required');
  if (!deps.staticDir) return void res.writeHead(404).end();
  const url = new URL(req.url ?? '/', 'http://x');
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const safePath = normalize(join(deps.staticDir, requested));
  if (!safePath.startsWith(resolve(deps.staticDir))) return void res.writeHead(403).end();
  if (!existsSync(safePath) || !statSync(safePath).isFile()) return void res.writeHead(404).end();
  const ext = extname(safePath);
  res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
  res.end(readFileSync(safePath));
}
