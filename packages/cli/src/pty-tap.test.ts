import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startPtyTap, type PtyTapHandle } from './pty-tap.js';

interface FakeHub {
  port: number;
  received: () => Buffer;
  close: () => Promise<void>;
  /** Drop any in-flight connections so the client sees a 'close' event. */
  drop: () => void;
}

async function startFakeHub(port = 0): Promise<FakeHub> {
  let bytes = Buffer.alloc(0);
  const server: Server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/raw')) {
      res.writeHead(404).end();
      return;
    }
    req.on('data', (c: Buffer) => {
      bytes = Buffer.concat([bytes, c]);
    });
    req.on('end', () => {
      if (!res.headersSent) res.writeHead(204).end();
    });
    req.on('error', () => {
      /* ignore */
    });
  });
  await new Promise<void>((r) => server.listen(port, r));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return {
    port: addr.port,
    received: () => bytes,
    drop: () => server.closeAllConnections?.(),
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('startPtyTap', () => {
  let tap: PtyTapHandle | null = null;
  let hub: FakeHub | null = null;

  afterEach(async () => {
    tap?.close();
    tap = null;
    if (hub) await hub.close();
    hub = null;
  });

  it('streams chunks to the hub while connected', async () => {
    hub = await startFakeHub();
    tap = startPtyTap({ hubUrl: `http://127.0.0.1:${hub.port}`, sessionId: 's1' });

    tap.writeChunk('hello ');
    tap.writeChunk('world');

    await waitFor(() => hub!.received().toString('utf-8').includes('hello world'));
    expect(hub.received().toString('utf-8')).toBe('hello world');
  });

  it('queues chunks while disconnected and flushes them after reconnect', async () => {
    hub = await startFakeHub();
    const port = hub.port;
    tap = startPtyTap({
      hubUrl: `http://127.0.0.1:${port}`,
      sessionId: 's2',
      initialBackoffMs: 30,
      maxBackoffMs: 60,
    });

    tap.writeChunk('A');
    await waitFor(() => hub!.received().toString('utf-8') === 'A');

    // Bring the hub down mid-stream.
    await hub.close();
    hub = null;

    // Give the client a moment to observe the disconnect (FIN/RST) so the next
    // writes go through the queue instead of into a half-dead socket.
    await new Promise((r) => setTimeout(r, 100));

    // These writes happen while disconnected — must be queued, not dropped.
    tap.writeChunk('B');
    tap.writeChunk('C');

    // Bring a fresh hub up on the SAME port. The tap's reconnect should
    // succeed and flush the queued bytes.
    hub = await startFakeHub(port);
    await waitFor(() => hub!.received().toString('utf-8') === 'BC', 5000);
    expect(hub.received().toString('utf-8')).toBe('BC');
  });

  it('drops oldest queued chunks past queueMax while disconnected', async () => {
    hub = await startFakeHub();
    const port = hub.port;
    tap = startPtyTap({
      hubUrl: `http://127.0.0.1:${port}`,
      sessionId: 's3',
      initialBackoffMs: 30,
      maxBackoffMs: 60,
      queueMax: 3,
    });

    // Wait for initial connection.
    tap.writeChunk('init');
    await waitFor(() => hub!.received().toString('utf-8') === 'init');

    await hub.close();
    hub = null;

    await new Promise((r) => setTimeout(r, 100));

    tap.writeChunk('1');
    tap.writeChunk('2');
    tap.writeChunk('3');
    tap.writeChunk('4');
    tap.writeChunk('5'); // should evict '1' and '2'

    hub = await startFakeHub(port);
    await waitFor(() => hub!.received().length > 0, 5000);
    // Queue holds last 3: '3','4','5'
    expect(hub.received().toString('utf-8')).toBe('345');
  });

  it('close() stops reconnect attempts and discards queued data', async () => {
    hub = await startFakeHub();
    const port = hub.port;
    tap = startPtyTap({
      hubUrl: `http://127.0.0.1:${port}`,
      sessionId: 's4',
      initialBackoffMs: 30,
      maxBackoffMs: 60,
    });

    tap.writeChunk('x');
    await waitFor(() => hub!.received().toString('utf-8') === 'x');

    await hub.close();
    hub = null;

    await new Promise((r) => setTimeout(r, 100));

    tap.writeChunk('queued');
    tap.close();

    // Bring the hub back; tap should not reconnect and not deliver 'queued'.
    hub = await startFakeHub(port);
    await new Promise((r) => setTimeout(r, 200));
    expect(hub.received().length).toBe(0);
  });
});
