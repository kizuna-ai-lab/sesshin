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
  it('eventsSince(sessionId, null) returns all recent', () => {
    const bus = new EventBus();
    bus.emit({ eventId: 'e1', sessionId: 's', kind: 'tool-call', payload: {}, source: 'observer:hook-ingest', ts: 1 });
    bus.emit({ eventId: 'e2', sessionId: 's', kind: 'tool-result', payload: {}, source: 'observer:hook-ingest', ts: 2 });
    expect(bus.eventsSince('s', null)).toHaveLength(2);
  });
  it('eventsSince filters strictly after the given id', () => {
    const bus = new EventBus();
    bus.emit({ eventId: 'e1', sessionId: 's', kind: 'tool-call', payload: {}, source: 'observer:hook-ingest', ts: 1 });
    bus.emit({ eventId: 'e2', sessionId: 's', kind: 'tool-result', payload: {}, source: 'observer:hook-ingest', ts: 2 });
    expect(bus.eventsSince('s', 'e1').map((e) => e.eventId)).toEqual(['e2']);
  });
});
