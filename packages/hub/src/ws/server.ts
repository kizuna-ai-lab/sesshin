import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, normalize, resolve, extname } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { SessionRegistry } from '../registry/session-registry.js';
import type { EventBus } from '../event-bus.js';
import type { PtyTap } from '../observers/pty-tap.js';
import { handleConnection } from './connection.js';

export interface WsServerDeps {
  registry: SessionRegistry;
  bus:      EventBus;
  tap:      PtyTap;
  staticDir: string | null;
  /** Called when a WS client sends an input.action or input.text. Wired in T38. */
  onInput?: (sessionId: string, data: string, source: string) => Promise<{ ok: boolean; reason?: string }>;
}

export interface WsServerInstance {
  listen(port: number, host: string): Promise<void>;
  close(): Promise<void>;
  address(): AddressInfo;
  broadcast(msg: object, filter?: (clientCaps: string[]) => boolean): void;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico':  'image/x-icon',
};

export function createWsServer(deps: WsServerDeps): WsServerInstance {
  const http = createServer((req, res) => serveHttp(req, res, deps));
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();

  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/v1/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
      handleConnection(ws, deps);
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
    broadcast: (msg, _filter) => {
      const data = JSON.stringify(msg);
      for (const ws of sockets) {
        // (filter is applied per-connection in T36 once capabilities are stored on the connection.)
        if ((ws as unknown as { readyState: number }).readyState === 1) ws.send(data);
      }
    },
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
