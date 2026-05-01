import { describe, it, expect } from 'vitest';
import { EventBus, type NormalizedEvent } from './event-bus.js';

describe('EventBus', () => {
  it('emits to all listeners', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on((e) => seen.push(e.kind));
    bus.on((e) => seen.push('also-' + e.kind));
    bus.emit({ sessionId: 's1', kind: 'user-prompt', payload: {}, source: 'observer:hook-ingest', ts: 1, eventId: 'e1' });
    expect(seen).toEqual(['user-prompt', 'also-user-prompt']);
  });
  it('stops emitting to a removed listener', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const fn = (e: NormalizedEvent) => seen.push(e.kind);
    bus.on(fn);
    bus.off(fn);
    bus.emit({ sessionId: 's1', kind: 'user-prompt', payload: {}, source: 'observer:hook-ingest', ts: 1, eventId: 'e1' });
    expect(seen).toEqual([]);
  });
});
