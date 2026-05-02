export interface DedupKey { sessionId: string; kind: string; ts: number; source: string }

export class Dedup {
  private last = new Map<string, number>();   // key → ts of last emit
  constructor(private opts: { windowMs: number }) {}

  shouldEmit(k: DedupKey): boolean {
    // agent-internal events are a passthrough channel, not a dedup target.
    if (k.kind === 'agent-internal') return true;
    // agent-output is emitted by both the Stop hook (payload.stopReason) and
    // the JSONL assistant block (payload.content). They carry distinct,
    // complementary info — the summarizer needs the JSONL content. Treating
    // them as duplicates loses the actual response text.
    if (k.kind === 'agent-output') return true;
    const tag = `${k.sessionId}|${k.kind}`;
    const lastTs = this.last.get(tag);
    if (lastTs !== undefined && k.ts - lastTs < this.opts.windowMs) return false;
    this.last.set(tag, k.ts);
    return true;
  }
}
