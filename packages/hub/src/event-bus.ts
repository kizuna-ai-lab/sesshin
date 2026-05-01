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
  on(fn: Listener): void { this.listeners.add(fn); }
  off(fn: Listener): void { this.listeners.delete(fn); }
  emit(e: NormalizedEvent): void { for (const fn of this.listeners) fn(e); }
}
