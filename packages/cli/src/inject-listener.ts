// packages/cli/src/inject-listener.ts
import { request, type IncomingMessage } from 'node:http';

/**
 * Open a long-lived NDJSON stream to the hub's sink-stream endpoint.
 * Each line is { data: string, source: string }; we forward `data` into the
 * provided write callback (typically the PTY).
 */
export interface InjectListenerOpts {
  hubUrl: string;
  sessionId: string;
  onInput: (data: string, source: string) => void;
}

export function startInjectListener(opts: InjectListenerOpts): { close(): void } {
  const url = new URL(opts.hubUrl);
  let closed = false;
  let req: ReturnType<typeof request> | null = null;
  const open = (): void => {
    if (closed) return;
    req = request({
      method: 'POST', host: url.hostname, port: Number(url.port),
      path: `/api/sessions/${opts.sessionId}/sink-stream`,
      headers: { 'content-type': 'application/json', 'connection': 'keep-alive' },
    }, (res: IncomingMessage) => {
      let buf = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          try {
            const j = JSON.parse(line);
            if (typeof j.data === 'string' && typeof j.source === 'string') opts.onInput(j.data, j.source);
          } catch { /* ignore malformed line */ }
        }
      });
      res.on('end', () => { if (!closed) setTimeout(open, 500); });
    });
    req.on('error', () => { if (!closed) setTimeout(open, 1000); });
    req.write('{}'); req.end();
  };
  open();
  return { close() { closed = true; req?.destroy(); } };
}
