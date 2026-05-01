import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import type { SessionRegistry } from '../registry/session-registry.js';

export interface RestServerDeps { registry: SessionRegistry }

export interface RestServer {
  listen(port: number, host: string): Promise<void>;
  close(): Promise<void>;
  address(): AddressInfo;
}

const RegisterBody = z.object({
  id:              z.string(),
  name:            z.string(),
  agent:           z.enum(['claude-code', 'codex', 'gemini', 'other']),
  cwd:             z.string(),
  pid:             z.number().int(),
  sessionFilePath: z.string(),
});

export function createRestServer(deps: RestServerDeps): RestServer {
  const server = createServer((req, res) => {
    route(req, res, deps).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: String(err?.message ?? err) }));
    });
  });

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

  if (url.pathname === '/api/sessions') {
    if (method === 'GET')  return listSessions(res, deps);
    if (method === 'POST') return registerSession(req, res, deps);
    return void res.writeHead(405).end();
  }
  const m = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (m) {
    const id = m[1]!;
    if (method === 'DELETE') return unregisterSession(id, res, deps);
    return void res.writeHead(405).end();
  }
  res.writeHead(404).end();
}

function health(method: string, res: ServerResponse): void {
  if (method !== 'GET') return void res.writeHead(405).end();
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

function listSessions(res: ServerResponse, deps: RestServerDeps): void {
  res.writeHead(200, { 'content-type': 'application/json' })
     .end(JSON.stringify(deps.registry.list()));
}

async function registerSession(req: IncomingMessage, res: ServerResponse, deps: RestServerDeps): Promise<void> {
  let body: unknown;
  try { body = await readJson(req); } catch { return void res.writeHead(400).end('bad json'); }
  const parsed = RegisterBody.safeParse(body);
  if (!parsed.success) return void res.writeHead(400, { 'content-type': 'application/json' })
                               .end(JSON.stringify({ error: parsed.error.format() }));
  const rec = deps.registry.register(parsed.data);
  res.writeHead(201, { 'content-type': 'application/json' })
     .end(JSON.stringify({ id: rec.id, registeredAt: rec.startedAt }));
}

function unregisterSession(id: string, res: ServerResponse, deps: RestServerDeps): void {
  const removed = deps.registry.unregister(id);
  if (!removed) return void res.writeHead(404).end();
  res.writeHead(204).end();
}
