import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { PermissionModeEnum, fingerprintToolInput, type PermissionRequestDecision, RateLimitsStateSchema, type RateLimitsState } from '@sesshin/shared';
import type { SessionRegistry } from '../registry/session-registry.js';
import type { PtyTap } from '../observers/pty-tap.js';
import type { ApprovalManager } from '../approval-manager.js';
import type { LifecycleHandler } from '../lifecycle/handler.js';
import type { Db } from '../storage/db.js';
import type { ClientInfo, HistoryEntry } from './diagnostics.js';
import { handlePermissionRoute } from './permission.js';
import { listSessions as catalogList, getSessionDetail } from './sessions-catalog.js';

export interface RestServerDeps {
  registry: SessionRegistry;
  /**
   * SQLite-backed catalog (sessions/messages/actions). Used by
   * `GET /api/v1/sessions` and `GET /api/v1/sessions/:id`. Optional only for
   * tests that don't exercise the catalog routes — when omitted, those
   * routes return 503.
   */
  db?: Db;
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
  /** Approval manager for diagnostics endpoint (T9). When omitted, /api/v1/diagnostics returns 503. */
  approvals?: ApprovalManager;
  /**
   * Lifecycle handler for `POST /api/v1/sessions/:id/lifecycle` passthrough
   * (used by CLI subcommands `sesshin pause/resume/kill/rename`). When
   * omitted, the route returns 501.
   */
  lifecycle?: LifecycleHandler;
  /** True iff there's a connected actions-capable client subscribed to this session. */
  hasSubscribedActionsClient?: (sessionId: string) => boolean;
  /** List currently-connected clients (filter to one session, or `null` for all). */
  listClients?: (sessionId: string | null) => ClientInfo[];
  /** Read recent prompt-resolution history for a session, newest-first. */
  historyForSession?: (sessionId: string, n: number) => HistoryEntry[];
  /** Update the PTY size reported by the CLI for a session. */
  onWinsize?: (sessionId: string, cols: number, rows: number) => void;
  /**
   * Called when the cli's pause-monitor reports a state flip. In the
   * nested-shell architecture, the cli polls /proc/<shellPid>/stat tpgid;
   * paused=true means the inner shell holds foreground (claude is suspended);
   * paused=false means a job (claude) holds foreground.
   */
  onPausedReport?: (sessionId: string, paused: boolean) => void;
  /** Fired when a rate-limit report arrives via POST /reports/rate-limits. */
  onRateLimitReport?: (env: { sessionId: string; state: RateLimitsState }) => void;
  /**
   * Called from the stale-cleanup path when a tool-completion event
   * (PostToolUse / PostToolUseFailure / Stop) successfully resolves one or
   * more pending approvals via `resolveByToolUseId/Fingerprint/Singleton`.
   * The wire layer uses this to broadcast `session.prompt-request.resolved`
   * to WS clients — otherwise the remote prompt UI stays in awaiting state
   * forever even though the underlying approval has already been decided.
   */
  onApprovalsCleanedUp?: (sessionId: string, requestIds: string[]) => void;
  /**
   * Diagnostic hook for the PTY banner tracker — returns the headless
   * terminal's current viewport content + per-anchor match positions so the
   * web debug panel and curl users can inspect why detection picks (or
   * doesn't pick) a given mode. Optional: `/banner-debug` returns 501 when
   * unwired.
   */
  inspectBanner?: (sessionId: string) => unknown | null;
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
});
const WinsizeBody = z.object({ cols: z.number().int().positive(), rows: z.number().int().positive() });
const PausedReportBody = z.object({ paused: z.boolean() });

const InjectBody = z.object({ data: z.string(), source: z.string() });

const RateLimitReportBody = z.object({
  sessionId: z.string(),
  five_hour: RateLimitsStateSchema.shape.five_hour,
  seven_day: RateLimitsStateSchema.shape.seven_day,
});

const LifecycleBody = z.object({
  action:    z.enum(['pause','resume','kill','rename','delete']),
  payload:   z.object({ name: z.string().min(1) }).optional(),
  requestId: z.string().optional(),
});

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

  // 410 Gone: every un-versioned `/api/...` path. Versioned API lives under
  // `/api/v1/...`; legacy paths return a structured error so old clients can
  // notice the bump rather than silently 404. Other top-level paths
  // (`/hooks`, `/permission/:sid`, `/reports/...`) are unversioned by design
  // and must keep working.
  if (url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/v1/')) {
    return void res.writeHead(410, { 'content-type': 'application/json' })
                   .end(JSON.stringify({ error: 'use /api/v1' }));
  }

  if (url.pathname === '/api/v1/health') return health(method, res);

  if (url.pathname === '/api/v1/sessions') {
    if (method === 'GET')  return listSessionsCatalog(url, res, deps);
    if (method === 'POST') return registerSession(req, res, deps);
    return void res.writeHead(405).end();
  }
  const raw = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/raw$/);
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
  const sink = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/sink-stream$/);
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
  const winsize = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/winsize$/);
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
  // cli's pause-monitor reports tpgid-derived paused state. Hub mirrors into
  // substate.paused and the existing substate-changed broadcast carries it
  // to debug-web for banner / input gating.
  const pausedReport = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/paused-state$/);
  if (pausedReport) {
    const id = pausedReport[1]!;
    if (method !== 'POST') return void res.writeHead(405).end();
    if (!deps.registry.get(id)) return void res.writeHead(404).end();
    let body: unknown;
    try { body = await readJson(req); } catch { return void res.writeHead(400).end('bad json'); }
    const parsed = PausedReportBody.safeParse(body);
    if (!parsed.success) return void res.writeHead(400, { 'content-type': 'application/json' })
                                 .end(JSON.stringify({ error: parsed.error.format() }));
    deps.onPausedReport?.(id, parsed.data.paused);
    return void res.writeHead(204).end();
  }
  const inj = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/inject$/);
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
  const bannerDebug = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/banner-debug$/);
  if (bannerDebug) {
    const id = bannerDebug[1]!;
    if (method !== 'GET') return void res.writeHead(405).end();
    if (!deps.registry.get(id)) {
      return void res.writeHead(404, { 'content-type': 'application/json' })
                     .end(JSON.stringify({ error: 'session-not-registered', sessionId: id }));
    }
    if (!deps.inspectBanner) {
      return void res.writeHead(501, { 'content-type': 'application/json' })
                     .end(JSON.stringify({ error: 'inspect-banner-not-wired' }));
    }
    const diag = deps.inspectBanner(id);
    if (!diag) {
      // Session is registered but the banner tracker has no record for it.
      // Most likely the session pre-existed before the tracker wired up
      // (legacy checkpoint) or the tracker has been stopped.
      return void res.writeHead(409, { 'content-type': 'application/json' })
                     .end(JSON.stringify({ error: 'tracker-not-attached', sessionId: id }));
    }
    return void res.writeHead(200, { 'content-type': 'application/json' })
                   .end(JSON.stringify(diag));
  }
  const lc = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/lifecycle$/);
  if (lc) {
    const id = lc[1]!;
    if (method !== 'POST') return void res.writeHead(405).end();
    if (!deps.lifecycle) return void res.writeHead(501, { 'content-type': 'application/json' })
                                 .end(JSON.stringify({ error: 'lifecycle-not-wired' }));
    let body: unknown;
    try { body = await readJson(req); } catch { return void res.writeHead(400).end('bad json'); }
    const parsed = LifecycleBody.safeParse(body);
    if (!parsed.success) return void res.writeHead(400, { 'content-type': 'application/json' })
                                 .end(JSON.stringify({ error: parsed.error.format() }));
    const requestId = parsed.data.requestId ?? `rest-${Date.now()}`;
    const msg = {
      type: 'session.lifecycle' as const,
      requestId,
      sessionId: id,
      action: parsed.data.action,
      ...(parsed.data.payload ? { payload: parsed.data.payload } : {}),
    };
    const result = deps.lifecycle.handle(msg, 'cli-local');
    const status = result.ok ? 200 : 409;
    const responseBody: Record<string, unknown> = { ok: result.ok };
    if (result.code) responseBody['code'] = result.code;
    if (result.message) responseBody['message'] = result.message;
    return void res.writeHead(status, { 'content-type': 'application/json' })
                   .end(JSON.stringify(responseBody));
  }
  const hb = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/heartbeat$/);
  if (hb) {
    const id = hb[1]!;
    if (method !== 'POST') return void res.writeHead(405).end();
    const ok = deps.registry.recordHeartbeat(id);
    return void res.writeHead(ok ? 204 : 404).end();
  }
  const m = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)$/);
  if (m) {
    const id = m[1]!;
    if (method === 'GET') return getSessionForRoute(id, res, deps);
    if (method === 'DELETE') return unregisterSession(id, res, deps);
    return void res.writeHead(405).end();
  }

  if (url.pathname === '/reports/rate-limits') {
    if (method !== 'POST') return void res.writeHead(405).end();
    let body: unknown;
    try { body = await readJson(req); } catch { return void res.writeHead(400).end('bad json'); }
    const parsed = RateLimitReportBody.safeParse(body);
    if (!parsed.success) {
      return void res.writeHead(400, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'invalid body', issues: parsed.error.issues }));
    }
    if (!deps.registry.get(parsed.data.sessionId)) return void res.writeHead(404).end();
    const state: RateLimitsState = {
      five_hour:   parsed.data.five_hour,
      seven_day:   parsed.data.seven_day,
      observed_at: Date.now(),
    };
    deps.onRateLimitReport?.({ sessionId: parsed.data.sessionId, state });
    return void res.writeHead(204).end();
  }

  if (url.pathname === '/hooks') {
    if (method !== 'POST') return void res.writeHead(405).end();
    return ingestHook(req, res, deps);
  }

  if (url.pathname === '/api/v1/diagnostics') {
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
  const cm = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/clients$/);
  if (cm) {
    const id = cm[1]!;
    if (method !== 'GET') return void res.writeHead(405).end();
    const list = deps.listClients?.(id) ?? [];
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(list));
  }
  const hm = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/history$/);
  if (hm) {
    const id = hm[1]!;
    if (method !== 'GET') return void res.writeHead(405).end();
    const rawN = Number(url.searchParams.get('n') ?? 20);
    const n = Number.isFinite(rawN) ? Math.min(100, Math.max(1, rawN)) : 20;
    const list = deps.historyForSession?.(id, n) ?? [];
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(list));
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

/**
 * `GET /api/v1/sessions` — paginated catalog of persisted sessions backed by
 * SQLite. Returns `{ sessions, hasMore }` where each entry includes
 * `messageCount` and a 200-char `lastMessage.contentPreview`. Supports query
 * params `?state=`, `?agent=`, `?before=`, `?limit=`, `?includeHidden=`,
 * `?includeEnded=`. When `db` is unwired (test fixtures), falls back to the
 * registry's live list to preserve the historical surface.
 */
function listSessionsCatalog(url: URL, res: ServerResponse, deps: RestServerDeps): void {
  if (!deps.db) {
    return void res.writeHead(200, { 'content-type': 'application/json' })
                   .end(JSON.stringify(deps.registry.list()));
  }
  const q = url.searchParams;
  const opts: {
    state?: string; agent?: string; before?: number; limit?: number;
    includeHidden?: boolean; includeEnded?: boolean;
  } = {};
  const state = q.get('state'); if (state) opts.state = state;
  const agent = q.get('agent'); if (agent) opts.agent = agent;
  const before = q.get('before');
  if (before !== null) {
    const n = Number(before);
    if (Number.isFinite(n)) opts.before = n;
  }
  const limit = q.get('limit');
  if (limit !== null) {
    const n = Number(limit);
    if (Number.isFinite(n)) opts.limit = n;
  }
  if (q.get('includeHidden') === 'true') opts.includeHidden = true;
  if (q.get('includeEnded')  === 'true') opts.includeEnded  = true;
  const result = catalogList(deps.db, opts);
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
}

/**
 * `GET /api/v1/sessions/:id` — full detail for a single session including the
 * last 50 messages. Resolves through the SQLite catalog so ended sessions
 * remain queryable; falls back to the registry-only `{ id }` shape if `db`
 * is unwired (legacy test fixtures).
 */
function getSessionForRoute(id: string, res: ServerResponse, deps: RestServerDeps): void {
  if (!deps.db) {
    if (!deps.registry.get(id)) return void res.writeHead(404).end();
    return void res.writeHead(200, { 'content-type': 'application/json' })
                   .end(JSON.stringify({ id }));
  }
  const detail = getSessionDetail(deps.db, id);
  if (!detail) return void res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(detail));
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
  res.writeHead(201, { 'content-type': 'application/json' })
     .end(JSON.stringify({ id: rec.id, registeredAt: rec.startedAt }));
}

function unregisterSession(id: string, res: ServerResponse, deps: RestServerDeps): void {
  const removed = deps.registry.unregister(id);
  if (!removed) return void res.writeHead(404).end();
  res.writeHead(204).end();
}
