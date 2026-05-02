// packages/cli/src/pty-tap.ts
import { request } from 'node:http';

/** Stream raw PTY chunks to the hub. Reuses a single keep-alive connection per session. */
export function startPtyTap(opts: { hubUrl: string; sessionId: string }): { writeChunk(data: string): void; close(): void } {
  const url = new URL(opts.hubUrl);
  const port = Number(url.port);
  let queue: Buffer[] = [];
  let req: ReturnType<typeof request> | null = null;

  const open = (): void => {
    req = request({
      method: 'POST', host: url.hostname, port,
      path: `/api/sessions/${opts.sessionId}/raw`,
      headers: { 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' },
    });
    req.on('error', () => { req = null; });
  };

  open();
  return {
    writeChunk(data) {
      const buf = Buffer.from(data, 'utf-8');
      if (req && !(req as unknown as { destroyed?: boolean }).destroyed) { req.write(buf); }
      else { queue.push(buf); if (queue.length > 64) queue.shift(); /* drop oldest */ }
    },
    close() { if (req) { req.end(); req = null; } },
  };
}
