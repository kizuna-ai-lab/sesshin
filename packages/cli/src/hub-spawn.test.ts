import { describe, it, expect } from 'vitest';
import { ensureHubRunning } from './hub-spawn.js';
import { createServer } from 'node:http';

describe('ensureHubRunning', () => {
  it('returns immediately when /api/health responds 200', async () => {
    const port = 19663;
    const s = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
    await new Promise<void>((r) => s.listen(port, '127.0.0.1', () => r()));
    try {
      const res = await ensureHubRunning({ hubBin: 'echo-not-used', port, healthTimeoutMs: 1000 });
      expect(res.spawned).toBe(false);
    } finally { s.close(); }
  });
  it('spawns when /api/health unreachable; resolves once new instance answers', async () => {
    // Use a tiny stub binary that listens on a port and returns 200.
    const port = 19664;
    const stub = `process.argv[1] && require('http').createServer((req,res)=>{res.writeHead(200);res.end('{"ok":true}')}).listen(${port},'127.0.0.1');`;
    const stubBin = process.execPath;
    const stubArgs = ['-e', stub, 'go'];
    const res = await ensureHubRunning({ hubBin: stubBin, hubArgs: stubArgs, port, healthTimeoutMs: 5000 });
    expect(res.spawned).toBe(true);
    // give the stub a moment to release the port
    await new Promise((r) => setTimeout(r, 50));
  }, 10000);
});
