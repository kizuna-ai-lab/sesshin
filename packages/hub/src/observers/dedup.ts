export interface DedupKey { sessionId: string; kind: string; ts: number; source: string }

export class Dedup {
  private last = new Map<string, number>();   // key → ts of last emit
  constructor(private opts: { windowMs: number }) {}

  shouldEmit(k: DedupKey): boolean {
    const tag = `${k.sessionId}|${k.kind}`;
    const lastTs = this.last.get(tag);
    if (lastTs !== undefined && k.ts - lastTs < this.opts.windowMs) return false;
    this.last.set(tag, k.ts);
    return true;
  }
}
