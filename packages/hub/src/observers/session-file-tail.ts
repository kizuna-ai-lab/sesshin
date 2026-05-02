import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import type { EventBus } from '../event-bus.js';
import { jsonlLineToEvent } from '../agents/claude/normalize-jsonl.js';

export interface TailOpts {
  sessionId: string;
  path: string;
  bus: EventBus;
  pollMs?: number;
  initialCursor?: number;
}

export function tailSessionFile(opts: TailOpts): () => void {
  const pollMs = opts.pollMs ?? 200;
  let cursor = opts.initialCursor ?? 0;
  let buf = '';
  let stopped = false;

  const tick = (): void => {
    if (stopped) return;
    try {
      if (!existsSync(opts.path)) return;
      const st = statSync(opts.path);
      if (st.size > cursor) {
        const fd = openSync(opts.path, 'r');
        try {
          const want = st.size - cursor;
          const chunk = Buffer.alloc(want);
          readSync(fd, chunk, 0, want, cursor);
          cursor = st.size;
          buf += chunk.toString('utf-8');
        } finally { closeSync(fd); }
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const event = jsonlLineToEvent(opts.sessionId, line);
          if (event) opts.bus.emit(event);
        }
      }
    } catch { /* ignore transient */ }
  };
  const handle = setInterval(tick, pollMs);
  return () => { stopped = true; clearInterval(handle); };
}
