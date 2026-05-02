import { describe, it, expect } from 'vitest';
import { ensureHubRunning } from './hub-spawn.js';
import { createServer } from 'node:http';

describe('ensureHubRunning', () => {
  it('returns immediately when /api/health responds 200', async () => {
    const s = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    const port = (s.address() as { port: number }).port;
    try {
      const res = await ensureHubRunning({ hubBin: 'echo-not-used', port, healthTimeoutMs: 1000 });
      expect(res.spawned).toBe(false);
    } finally { s.close(); }
  });
  it('spawns when /api/health unreachable; resolves once new instance answers', async () => {
    // Pick a free ephemeral port by listening on it then closing — avoids hardcoded port collisions.
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));

    // Stub binary listens on the chosen port and returns 200 on /api/health.
    const stub = `require('http').createServer((req,res)=>{res.writeHead(200);res.end('{"ok":true}')}).listen(${port},'127.0.0.1');`;
    const stubBin = process.execPath;
    const stubArgs = ['-e', stub];
    const res = await ensureHubRunning({ hubBin: stubBin, hubArgs: stubArgs, port, healthTimeoutMs: 5000 });
    expect(res.spawned).toBe(true);
    // give the stub a moment to release the port
    await new Promise((r) => setTimeout(r, 50));
  }, 10000);
});
