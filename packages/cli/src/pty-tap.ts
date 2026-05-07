// packages/cli/src/pty-tap.ts
import { request, type ClientRequest } from 'node:http';

export interface PtyTapHandle {
  writeChunk(data: string): void;
  close(): void;
}

export interface PtyTapOptions {
  hubUrl: string;
  sessionId: string;
  /** Max queued chunks while reconnecting. Drops oldest on overflow. Default 1024. */
  queueMax?: number;
  /** Initial reconnect delay in ms (doubles up to maxBackoffMs). Default 100. */
  initialBackoffMs?: number;
  /** Cap for reconnect backoff. Default 5000. */
  maxBackoffMs?: number;
}

/**
 * Stream raw PTY chunks to the hub via a long-lived chunked POST.
 *
 * If the upstream connection drops (hub restarted, transient network), chunks
 * received during the gap are queued (bounded ring) and flushed on the next
 * successful reconnect, so late-joining web clients still see the full
 * pre-reconnect history through the hub's snapshot mechanism.
 */
export function startPtyTap(opts: PtyTapOptions): PtyTapHandle {
  const url = new URL(opts.hubUrl);
  // url.port is '' when the URL omits an explicit port; Number('') is 0,
  // which is invalid. Default by protocol so http://host/path also works.
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  const queueMax = opts.queueMax ?? 1024;
  const initialBackoffMs = opts.initialBackoffMs ?? 100;
  const maxBackoffMs = opts.maxBackoffMs ?? 5000;

  const queue: Buffer[] = [];
  let req: ClientRequest | null = null;
  let connected = false;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffMs = initialBackoffMs;

  const flushQueue = (): void => {
    if (!req || isDestroyed(req)) return;
    while (queue.length > 0) {
      const buf = queue.shift()!;
      const ok = req.write(buf);
      if (!ok) {
        req.once('drain', flushQueue);
        return;
      }
    }
  };

  const scheduleReconnect = (): void => {
    if (closed || reconnectTimer) return;
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, delay);
  };

  const open = (): void => {
    if (closed) return;
    const r = request({
      method: 'POST',
      host: url.hostname,
      port,
      path: `/api/v1/sessions/${opts.sessionId}/raw`,
      headers: {
        'content-type': 'application/octet-stream',
        'transfer-encoding': 'chunked',
      },
    });
    req = r;
    connected = false;

    const teardown = (): void => {
      if (req === r) {
        req = null;
        connected = false;
      }
      scheduleReconnect();
    };

    r.on('error', teardown);
    r.on('close', teardown);
    r.on('socket', (sock) => {
      const onConnect = (): void => {
        connected = true;
        backoffMs = initialBackoffMs;
        flushQueue();
      };
      if ((sock as { connecting?: boolean }).connecting === false) {
        // Already connected (e.g., reused agent socket).
        onConnect();
      } else {
        sock.once('connect', onConnect);
      }
    });
  };

  open();

  return {
    writeChunk(data: string): void {
      if (closed) return;
      const buf = Buffer.from(data, 'utf-8');
      // Always enqueue first, then flush. Routing through the queue keeps the
      // bound (queueMax) honored and ensures backpressure observed during
      // flushQueue (req.write returning false → drain wait) doesn't get
      // bypassed by a fast-path write.
      queue.push(buf);
      while (queue.length > queueMax) queue.shift();
      if (req && connected && req.writable && !isDestroyed(req)) flushQueue();
    },
    close(): void {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (req && !isDestroyed(req)) {
        try {
          req.end();
        } catch {
          /* ignore */
        }
      }
      req = null;
      queue.length = 0;
    },
  };
}

function isDestroyed(r: ClientRequest): boolean {
  return Boolean((r as unknown as { destroyed?: boolean }).destroyed);
}
