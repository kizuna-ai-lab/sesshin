import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { PermissionModeEnum, fingerprintToolInput, type PermissionRequestDecision } from '@sesshin/shared';
import type { SessionRegistry } from '../registry/session-registry.js';
import type { PtyTap } from '../observers/pty-tap.js';
import type { ApprovalManager } from '../approval-manager.js';
import type { ClientInfo, HistoryEntry } from './diagnostics.js';
import { handlePermissionRoute } from './permission.js';

export interface RestServerDeps {
  registry: SessionRegistry;
  /** Fired when a valid hook event arrives. Wired in T26. */
  onHookEvent?: (envelope: { agent: string; sessionId: string; ts: number; event: string; raw: Record<string, unknown> }) => void;
  /** PtyTap for raw byte ingest (T30/M4). */
  tap?: PtyTap;
  /** Called when the hub itself wants to push input back into the CLI. Wired in T39. */
  onInjectFromHub?: (sessionId: string, data: string, source: string) => Promise<boolean>;
  /** When CLI opens the sink-stream, hub registers a delivery function for that session. */
  onAttachSink?: (sessionId: string, deliver: (data: string, source: string) => Promise<void>) => void;
  /** Called when the CLI sink-stream connection closes (so the bridge can drop the sink). */
  onDetachSink?: (sessionId: string) => void;
  /**
   * Called for PermissionRequest HTTP hooks (Claude Code's real approval gate).
   * Body shape is distinct from PreToolUse: returning a decision yields the
   * `behavior` shape (no `ask` — PermissionRequest has no equivalent).
   * Returning `null` means passthrough → 204 so Claude falls back to its TUI.
   *
   * Decision uses the shared discriminated union: `allow` may carry
   * `updatedInput`, `deny` may carry `message`, and the type system rejects
   * the cross-product (no `message` on allow, no `updatedInput` on deny).
   */
  onPermissionRequestApproval?: (envelope: {
    agent: string; sessionId: string; ts: number; event: string; raw: Record<string, unknown>;
  }) => Promise<PermissionRequestDecision | null>;
  /** Approval manager for diagnostics endpoint (T9). When omitted, /api/diagnostics returns 503. */
  approvals?: ApprovalManager;
  /** True iff there's a connected actions-capable client subscribed to this session. */
  hasSubscribedActionsClient?: (sessionId: string) => boolean;
  /** List currently-connected clients (filter to one session, or `null` for all). */
  listClients?: (sessionId: string | null) => ClientInfo[];
  /** Read recent prompt-resolution history for a session, newest-first. */
  historyForSession?: (sessionId: string, n: number) => HistoryEntry[];
  /** Update the PTY size reported by the CLI for a session. */
  onWinsize?: (sessionId: string, cols: number, rows: number) => void;
  /**
   * Called from the stale-cleanup path when a tool-completion event
   * (PostToolUse / PostToolUseFailure / Stop) successfully resolves one or
   * more pending approvals via `resolveByToolUseId/Fingerprint/Singleton`.
   * The wire layer uses this to broadcast `session.prompt-request.resolved`
   * to WS clients — otherwise the remote prompt UI stays in awaiting state
   * forever even though the underlying approval has already been decided.
   */
  onApprovalsCleanedUp?: (sessionId: string, requestIds: string[]) => void;
}

export interface RestServer {
  listen(port: number, host: string): Promise<void>;
  close(): Promise<void>;
  address(): AddressInfo;
}

const RegisterBody = z.object({
  id:                    z.string(),
  name:                  z.string(),
  agent:                 z.enum(['claude-code', 'codex', 'gemini', 'other']),
  cwd:                   z.string(),
  pid:                   z.number().int(),
  sessionFilePath:       z.string(),
  cols:                  z.number().int().positive().optional(),
  rows:                  z.number().int().positive().optional(),
  initialPermissionMode: PermissionModeEnum.optional(),
  claudeAllowRules:      z.array(z.string()).optional(),
});
const WinsizeBody = z.object({ cols: z.number().int().positive(), rows: z.number().int().positive() });

const InjectBody = z.object({ data: z.string(), source: z.string() });

const HookBody = z.object({
  agent:     z.enum(['claude-code','codex','gemini','other']),
  sessionId: z.string(),
  ts:        z.number().int(),
  event:     z.string(),
  raw:       z.record(z.string(), z.unknown()),
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
    close: () => new Promise((resolve, reject) => {
      // Sesshin's REST server holds open long-poll connections (the CLI
      // raw-byte ingest, sink-stream, and approval HTTP holds). server.close
      // only stops accepting new connections and resolves only after every
      // in-flight request finishes — which never happens for those long-lived
      // connections, so plain close hangs forever on shutdown. Force-close
      // the active sockets after stopping accept so the drain wait completes.
      // Order is the canonical Node pattern: close() first (synchronously
      // stops accepting + arms the callback), then closeAllConnections()
      // destroys the remaining sockets so close()'s callback fires.
      server.close((e) => (e ? reject(e) : resolve()));
      server.closeAllConnections?.();   // node 18.2+
    }),
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
  const raw = url.pathname.match(/^\/api\/sessions\/([^/]+)\/raw$/);
  if (raw) {
    const id = raw[1]!;
    if (method !== 'POST') return void res.writeHead(405).end();
    if (!deps.registry.get(id)) return void res.writeHead(404).end();
    if (!deps.tap) return void res.writeHead(501).end();
    // The CLI sends raw PTY bytes as a long-lived `transfer-encoding: chunked`
    // POST that never ends. Process each chunk incrementally so subscribers
    // (debug-web `session.raw`) see output in real time. Buffering until
    // request end (`for await`) would mean nothing is ever published.
    const tap = deps.tap;
    req.on('data', (c: Buffer) => {
      try { tap.append(id, c); } catch { /* ring may be dropped; ignore */ }
    });
    req.on('end',   () => { if (!res.headersSent) res.writeHead(204).end(); });
    req.on('close', () => { if (!res.headersSent) res.writeHead(204).end(); });
    req.on('error', () => { if (!res.headersSent) res.writeHead(400).end(); });
    return;
  }
  const sink = url.pathname.match(/^\/api\/sessions\/([^/]+)\/sink-stream$/);
  if (sink) {
    const id = sink[1]!;
    if (method !== 'POST') return void res.writeHead(405).end();
    if (!deps.registry.get(id)) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' });
    deps.onAttachSink?.(id, async (data, source) => {
      res.write(JSON.stringify({ data, source }) + '\n');
    });
    const detach = (): void => { deps.onDetachSink?.(id); };
    req.on('close', detach);
    res.on('close', detach);
    return;
  }
  const winsize = url.pathname.match(/^\/api\/sessions\/([^/]+)\/winsize$/);
  if (winsize) {
    const id = winsize[1]!;
    if (method !== 'POST') return void res.writeHead(405).end();
    if (!deps.registry.get(id)) return void res.writeHead(404).end();
    let body: unknown;
    try { body = await readJson(req); } catch { return void res.writeHead(400).end('bad json'); }
    const parsed = WinsizeBody.safeParse(body);
    if (!parsed.success) return void res.writeHead(400, { 'content-type': 'application/json' })
                                 .end(JSON.stringify({ error: parsed.error.format() }));
    deps.onWinsize?.(id, parsed.data.cols, parsed.data.rows);
    return void res.writeHead(204).end();
  }
  const inj = url.pathname.match(/^\/api\/sessions\/([^/]+)\/inject$/);
  if (inj) {
    const id = inj[1]!;
    if (method !== 'POST') return void res.writeHead(405).end();
    if (!deps.registry.get(id)) return void res.writeHead(404).end();
    let body: unknown;
    try { body = await readJson(req); } catch { return void res.writeHead(400).end(); }
    const parsed = InjectBody.safeParse(body);
    if (!parsed.success) return void res.writeHead(400).end();
    const ok = await deps.onInjectFromHub?.(id, parsed.data.data, parsed.data.source);
    return void res.writeHead(ok ? 204 : 502).end();
  }
  const hb = url.pathname.match(/^\/api\/sessions\/([^/]+)\/heartbeat$/);
  if (hb) {
    const id = hb[1]!;
    if (method !== 'POST') return void res.writeHead(405).end();
    const ok = deps.registry.recordHeartbeat(id);
    return void res.writeHead(ok ? 204 : 404).end();
  }
  const m = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (m) {
    const id = m[1]!;
    if (method === 'GET') {
      if (!deps.registry.get(id)) return void res.writeHead(404).end();
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id }));
    }
    if (method === 'DELETE') return unregisterSession(id, res, deps);
    return void res.writeHead(405).end();
  }

  if (url.pathname === '/hooks') {
    if (method !== 'POST') return void res.writeHead(405).end();
    return ingestHook(req, res, deps);
  }

  if (url.pathname === '/api/diagnostics') {
    if (method !== 'GET') return void res.writeHead(405).end();
    if (!deps.approvals) return void res.writeHead(503).end();
    const { writeDiagnostics } = await import('./diagnostics.js');
    return writeDiagnostics(res, {
      registry: deps.registry,
      approvals: deps.approvals,
      hasSubscribedActionsClient: deps.hasSubscribedActionsClient ?? (() => false),
      listClients: deps.listClients ?? (() => []),
      historyForSession: deps.historyForSession ?? (() => []),
    });
  }
  const cm = url.pathname.match(/^\/api\/sessions\/([^/]+)\/clients$/);
  if (cm) {
    const id = cm[1]!;
    if (method !== 'GET') return void res.writeHead(405).end();
    const list = deps.listClients?.(id) ?? [];
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(list));
  }
  const hm = url.pathname.match(/^\/api\/sessions\/([^/]+)\/history$/);
  if (hm) {
    const id = hm[1]!;
    if (method !== 'GET') return void res.writeHead(405).end();
    const rawN = Number(url.searchParams.get('n') ?? 20);
    const n = Number.isFinite(rawN) ? Math.min(100, Math.max(1, rawN)) : 20;
    const list = deps.historyForSession?.(id, n) ?? [];
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(list));
  }
  const gm = url.pathname.match(/^\/api\/sessions\/([^/]+)\/gate$/);
  if (gm) {
    const id = gm[1]!;
    if (method !== 'POST') return void res.writeHead(405).end();
    let body: unknown;
    try { body = await readJson(req); } catch { return void res.writeHead(400).end(); }
    const obj = (body && typeof body === 'object' ? body as Record<string, unknown> : {});
    const p = obj['policy'];
    if (typeof p !== 'string' || !['disabled', 'auto', 'always'].includes(p)) return void res.writeHead(400).end();
    return void res.writeHead(deps.registry.setSessionGateOverride(id, p as 'disabled' | 'auto' | 'always') ? 204 : 404).end();
  }
  const pm = url.pathname.match(/^\/api\/sessions\/([^/]+)\/pin$/);
  if (pm) {
    const id = pm[1]!;
    if (method !== 'POST') return void res.writeHead(405).end();
    let body: unknown;
    try { body = await readJson(req); } catch { return void res.writeHead(400).end(); }
    const obj = (body && typeof body === 'object' ? body as Record<string, unknown> : {});
    const msg = obj['message'];
    const msgStr = typeof msg === 'string' && msg.length > 0 ? msg : null;
    return void res.writeHead(deps.registry.setPin(id, msgStr) ? 204 : 404).end();
  }
  const qm = url.pathname.match(/^\/api\/sessions\/([^/]+)\/quiet$/);
  if (qm) {
    const id = qm[1]!;
    if (method !== 'POST') return void res.writeHead(405).end();
    let body: unknown;
    try { body = await readJson(req); } catch { return void res.writeHead(400).end(); }
    const obj = (body && typeof body === 'object' ? body as Record<string, unknown> : {});
    const ttlRaw = obj['ttlMs'];
    const ttl = Number(ttlRaw ?? 0);
    if (!Number.isFinite(ttl) || ttl < 0) return void res.writeHead(400).end();
    const until = ttl > 0 ? Date.now() + ttl : null;
    return void res.writeHead(deps.registry.setQuietUntil(id, until) ? 204 : 404).end();
  }

  const permRoute = url.pathname.match(/^\/permission\/([^/]+)$/);
  if (permRoute) {
    const sid = permRoute[1]!;
    if (method !== 'POST') return void res.writeHead(405).end();
    return handlePermissionRoute(req, res, sid, deps);
  }

  res.writeHead(404).end();
}

async function ingestHook(req: IncomingMessage, res: ServerResponse, deps: RestServerDeps): Promise<void> {
  let body: unknown;
  try { body = await readJson(req); } catch { return void res.writeHead(400).end('bad json'); }
  const parsed = HookBody.safeParse(body);
  if (!parsed.success) return void res.writeHead(400).end();
  if (parsed.data.event === 'PermissionRequest') {
    return void res.writeHead(400, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: 'PermissionRequest must be POSTed to /permission/:sessionId, not /hooks' }));
  }
  if (!deps.registry.get(parsed.data.sessionId)) return void res.writeHead(404).end();
  // Always emit the event onto the bus (state machine, summary trigger, …).
  deps.onHookEvent?.(parsed.data);

  // Stale-pending cleanup: when a tool either completes (PostToolUse /
  // PostToolUseFailure) or the turn ends (Stop), resolve any pending
  // approval that matches by `(sessionId, toolUseId)` exact, then by
  // `(sessionId, toolName, fingerprint)` (only when fingerprint set has
  // exactly one entry without toolUseId), then on Stop only by singleton.
  if (parsed.data.event === 'PostToolUse'
   || parsed.data.event === 'PostToolUseFailure'
   || parsed.data.event === 'Stop') {
    if (deps.approvals) {
      const raw = parsed.data.raw;
      const tuid = typeof raw['tool_use_id'] === 'string' ? raw['tool_use_id'] : null;
      const toolName = typeof raw['tool_name'] === 'string' ? raw['tool_name'] : null;
      const fp = (toolName && raw['tool_input'] && typeof raw['tool_input'] === 'object')
        ? fingerprintToolInput(raw['tool_input'])
        : null;
      const outcome = {
        decision: 'deny' as const,
        reason: 'sesshin: tool already moved past pending request',
      };
      const sid = parsed.data.sessionId;

      const resolvedExact = tuid ? deps.approvals.resolveByToolUseId(sid, tuid, outcome) : null;
      const resolvedFp = (resolvedExact === null && toolName && fp)
        ? deps.approvals.resolveByFingerprint(sid, toolName, fp, outcome)
        : null;
      const resolvedSingleton = (resolvedExact === null && resolvedFp === null && parsed.data.event === 'Stop')
        ? deps.approvals.resolveSingletonForSession(sid, outcome)
        : null;
      // Collect every requestId that just got resolved by stale-cleanup so the
      // wire layer can broadcast `session.prompt-request.resolved` to clients
      // (otherwise a remote client would keep showing the awaiting prompt
      // forever — the approval manager itself stays out of the WS layer).
      const cleanedUp = [resolvedExact, resolvedFp, resolvedSingleton].filter((x): x is string => x !== null);
      if (cleanedUp.length > 0) {
        deps.onApprovalsCleanedUp?.(sid, cleanedUp);
      }
    }
  }
  // PermissionRequest is the only approval gate; PreToolUse hook envelopes
  // are still observed for state-machine substate updates (handled above
  // via onHookEvent + the stale-cleanup path) but never gate.
  res.writeHead(204).end();
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
  if (parsed.data.initialPermissionMode) {
    deps.registry.setPermissionMode(rec.id, parsed.data.initialPermissionMode);
  }
  if (parsed.data.claudeAllowRules) {
    deps.registry.setClaudeAllowRules(rec.id, parsed.data.claudeAllowRules);
  }
  res.writeHead(201, { 'content-type': 'application/json' })
     .end(JSON.stringify({ id: rec.id, registeredAt: rec.startedAt }));
}

function unregisterSession(id: string, res: ServerResponse, deps: RestServerDeps): void {
  const removed = deps.registry.unregister(id);
  if (!removed) return void res.writeHead(404).end();
  res.writeHead(204).end();
}
