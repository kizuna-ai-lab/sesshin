type Subscriber = (chunk: Buffer, seq: number) => void;

interface SessionRing {
  buf: Buffer;
  used: number;     // bytes currently in buf
  seq: number;      // running byte counter (never decreases)
  subs: Set<Subscriber>;
}

export class PtyTap {
  private rings = new Map<string, SessionRing>();
  constructor(private opts: { ringBytes: number }) {}

  append(sessionId: string, chunk: Buffer): { seq: number } {
    const r = this.ring(sessionId);
    r.seq += chunk.length;
    // Append + rotate
    if (chunk.length >= this.opts.ringBytes) {
      chunk.copy(r.buf, 0, chunk.length - this.opts.ringBytes);
      r.used = this.opts.ringBytes;
    } else if (r.used + chunk.length <= this.opts.ringBytes) {
      chunk.copy(r.buf, r.used);
      r.used += chunk.length;
    } else {
      const drop = r.used + chunk.length - this.opts.ringBytes;
      r.buf.copy(r.buf, 0, drop, r.used);
      r.used -= drop;
      chunk.copy(r.buf, r.used);
      r.used += chunk.length;
    }
    for (const sub of r.subs) sub(chunk, r.seq);
    return { seq: r.seq };
  }

  snapshot(sessionId: string): Buffer {
    const r = this.rings.get(sessionId);
    if (!r) return Buffer.alloc(0);
    return r.buf.slice(0, r.used);
  }

  currentSeq(sessionId: string): number {
    return this.rings.get(sessionId)?.seq ?? 0;
  }

  subscribe(sessionId: string, sub: Subscriber): () => void {
    const r = this.ring(sessionId);
    r.subs.add(sub);
    return () => r.subs.delete(sub);
  }

  drop(sessionId: string): void { this.rings.delete(sessionId); }

  private ring(sessionId: string): SessionRing {
    let r = this.rings.get(sessionId);
    if (!r) {
      r = { buf: Buffer.alloc(this.opts.ringBytes), used: 0, seq: 0, subs: new Set() };
      this.rings.set(sessionId, r);
    }
    return r;
  }
}
