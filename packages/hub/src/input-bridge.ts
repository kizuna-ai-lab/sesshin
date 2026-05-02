// packages/hub/src/input-bridge.ts
type Sink = (data: string, source: string) => Promise<void>;

export class InputBridge {
  private sinks = new Map<string, Sink>();

  setSink(sessionId: string, sink: Sink): void { this.sinks.set(sessionId, sink); }
  clearSink(sessionId: string): void { this.sinks.delete(sessionId); }

  async deliver(sessionId: string, data: string, source: string): Promise<{ ok: boolean; reason?: string }> {
    const sink = this.sinks.get(sessionId);
    if (!sink) return { ok: false, reason: 'session-offline' };
    try { await sink(data, source); return { ok: true }; }
    catch { return { ok: false, reason: 'sink-error' }; }
  }
}
