import { describe, it, expect } from 'vitest';
import { EventBus } from '../event-bus.js';
import { wireHookIngest } from './hook-ingest.js';
import { SessionRegistry } from '../registry/session-registry.js';

describe('wireHookIngest', () => {
  it('Claude hook envelope produces a normalized event on the bus', () => {
    const bus = new EventBus();
    const reg = new SessionRegistry();
    reg.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/c', pid: 1, sessionFilePath: '/p' });
    const events: any[] = [];
    bus.on((e) => events.push(e));
    const ingest = wireHookIngest({ bus, registry: reg });
    ingest({ agent: 'claude-code', sessionId: 's1', ts: 1, event: 'Stop', raw: { nativeEvent: 'Stop' } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sessionId: 's1', kind: 'agent-output' });
  });
  it('drops envelopes for unknown sessions', () => {
    const bus = new EventBus();
    const events: any[] = [];
    bus.on((e) => events.push(e));
    const ingest = wireHookIngest({ bus, registry: new SessionRegistry() });
    ingest({ agent: 'claude-code', sessionId: 'missing', ts: 1, event: 'Stop', raw: {} });
    expect(events).toHaveLength(0);
  });
  it('routes non-claude agents to the agent-internal pass-through (v1 only Claude)', () => {
    const bus = new EventBus();
    const reg = new SessionRegistry();
    reg.register({ id: 's2', name: 'n', agent: 'other', cwd: '/c', pid: 1, sessionFilePath: '/p' });
    const events: any[] = [];
    bus.on((e) => events.push(e));
    const ingest = wireHookIngest({ bus, registry: reg });
    ingest({ agent: 'other', sessionId: 's2', ts: 1, event: 'Whatever', raw: {} });
    expect(events[0].kind).toBe('agent-internal');
  });
});
