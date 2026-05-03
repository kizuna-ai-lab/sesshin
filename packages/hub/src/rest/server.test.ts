import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRestServer, type RestServer } from './server.js';
import { SessionRegistry } from '../registry/session-registry.js';
import { PtyTap } from '../observers/pty-tap.js';
import { request as httpRequest } from 'node:http';

let svr: RestServer;
let port: number;
beforeEach(async () => {
  svr = createRestServer({ registry: new SessionRegistry() });
  await svr.listen(0, '127.0.0.1');
  port = svr.address().port;
});
afterEach(async () => { await svr.close(); });

describe('/api/health', () => {
  it('returns 200 with { ok: true } on GET', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });
  it('returns 405 on non-GET', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { method: 'POST' });
    expect(r.status).toBe(405);
  });
});

describe('/api/sessions/:id/raw — streaming', () => {
  it('publishes each chunk to subscribers before the request ends', async () => {
    // The CLI sends a long-lived chunked POST. Subscribers must see chunks
    // as they arrive — buffering until end would mean debug-web never sees
    // terminal output.
    const registry = new SessionRegistry();
    const tap = new PtyTap({ ringBytes: 4096 });
    const server = createRestServer({ registry, tap });
    await server.listen(0, '127.0.0.1');
    const localPort = server.address().port;
    try {
      const sid = 'abcdef0011223344';
      registry.register({ id: sid, name: 'n', agent: 'claude-code', cwd: '/tmp', pid: 1, sessionFilePath: '/tmp/x.jsonl' });

      const seen: string[] = [];
      const off = tap.subscribe(sid, (chunk) => seen.push(chunk.toString('utf-8')));

      const req = httpRequest({
        method: 'POST', host: '127.0.0.1', port: localPort,
        path: `/api/sessions/${sid}/raw`,
        headers: { 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' },
      });
      req.on('error', () => {});
      req.write('first ');
      // Give the server a tick to process the chunk.
      await new Promise((r) => setTimeout(r, 30));
      expect(seen.join('')).toBe('first ');
      req.write('second');
      await new Promise((r) => setTimeout(r, 30));
      expect(seen.join('')).toBe('first second');
      req.destroy();
      off();
    } finally {
      await server.close();
    }
  });
});

describe('shutdown', () => {
  it('close() resolves promptly even with active long-poll connections', async () => {
    // Regression: graceful shutdown previously hung forever when long-lived
    // chunked POSTs (e.g. raw byte ingest, sink-stream) were active —
    // server.close() waits for every in-flight request to finish, but those
    // never end on their own. Listen socket would close immediately, but
    // the process kept event-looping on the active connections, leaving the
    // hub half-dead (port not listening, but not exited either). Fix:
    // server.closeAllConnections() force-terminates them so close resolves.
    const registry = new SessionRegistry();
    const tap = new PtyTap({ ringBytes: 4096 });
    const server = createRestServer({ registry, tap });
    await server.listen(0, '127.0.0.1');
    const localPort = server.address().port;

    const sid = 'longpoll-shutdown-test';
    registry.register({ id: sid, name: 'n', agent: 'claude-code', cwd: '/tmp', pid: 1, sessionFilePath: '/tmp/x.jsonl' });

    // Open a long-lived chunked POST (the canonical hang-causing pattern).
    const req = httpRequest({
      method: 'POST', host: '127.0.0.1', port: localPort,
      path: `/api/sessions/${sid}/raw`,
      headers: { 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' },
    });
    req.on('error', () => {});
    req.write('keepalive');
    // Wait for the chunk to actually reach the server before testing close().
    await new Promise((r) => setTimeout(r, 50));

    // close() must resolve within a small bounded time even though req is
    // still streaming. 1 second is generous; if the regression returns this
    // would hang for the full test timeout (5s default).
    const start = Date.now();
    await Promise.race([
      server.close(),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('server.close() did not resolve within 1s')), 1000)),
    ]);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);

    req.destroy();
  });
});
