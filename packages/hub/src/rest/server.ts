import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SessionRegistry } from '../registry/session-registry.js';

export interface RestServerDeps { registry: SessionRegistry }

export interface RestServer {
  listen(port: number, host: string): Promise<void>;
  close(): Promise<void>;
  address(): AddressInfo;
}

export function createRestServer(deps: RestServerDeps): RestServer {
  const server = createServer((req, res) => route(req, res, deps));

  return {
    listen: (port, host) => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolve(); });
    }),
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
    address: () => server.address() as AddressInfo,
  };
}

async function route(req: IncomingMessage, res: ServerResponse, deps: RestServerDeps): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  const method = req.method ?? 'GET';
  if (url.pathname === '/api/health') return health(method, res);
  res.writeHead(404).end();
}

function health(method: string, res: ServerResponse): void {
  if (method !== 'GET') return void res.writeHead(405).end();
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
}
