import type { EventKind } from '@sesshin/shared';

export interface NormalizedEvent {
  eventId:    string;
  sessionId:  string;
  kind:       EventKind;
  payload:    Record<string, unknown>;
  source:     string;
  ts:         number;
  nativeEvent?: string;
}
type Listener = (e: NormalizedEvent) => void;

export class EventBus {
  private listeners = new Set<Listener>();
  private recent = new Map<string, NormalizedEvent[]>();
  private readonly maxPerSession = 200;

  on(fn: Listener): void { this.listeners.add(fn); }
  off(fn: Listener): void { this.listeners.delete(fn); }
  emit(e: NormalizedEvent): void {
    let arr = this.recent.get(e.sessionId);
    if (!arr) { arr = []; this.recent.set(e.sessionId, arr); }
    arr.push(e);
    if (arr.length > this.maxPerSession) arr.shift();
    for (const fn of this.listeners) fn(e);
  }
  /** Return events for a session strictly after the given eventId (or all if eventId is unknown / null). */
  eventsSince(sessionId: string, eventId: string | null): NormalizedEvent[] {
    const arr = this.recent.get(sessionId) ?? [];
    if (!eventId) return arr.slice();
    const idx = arr.findIndex((e) => e.eventId === eventId);
    return idx >= 0 ? arr.slice(idx + 1) : arr.slice();
  }
}
