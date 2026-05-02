import { describe, it, expect } from 'vitest';
import { wireJsonlModeTracker } from './jsonl-mode-tracker.js';
import { EventBus } from '../event-bus.js';
import { SessionRegistry } from '../registry/session-registry.js';

describe('jsonl-mode-tracker', () => {
  it('updates registry permissionMode when bus emits agent-internal mode-change', () => {
    const bus = new EventBus();
    const reg = new SessionRegistry();
    reg.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    wireJsonlModeTracker({ bus, registry: reg });
    bus.emit({
      eventId: 'e1', sessionId: 's1', ts: 1,
      kind: 'agent-internal',
      payload: { phase: 'mode-change', mode: 'auto' },
      source: 'observer:session-file-tail',
    });
    expect(reg.get('s1')?.substate.permissionMode).toBe('auto');
  });

  it('ignores agent-internal events without phase=mode-change', () => {
    const bus = new EventBus();
    const reg = new SessionRegistry();
    reg.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    wireJsonlModeTracker({ bus, registry: reg });
    bus.emit({
      eventId: 'e1', sessionId: 's1', ts: 1,
      kind: 'agent-internal',
      payload: { phase: 'session-start' },
      source: 'observer:hook-ingest',
    });
    expect(reg.get('s1')?.substate.permissionMode).toBe('default');
  });
});
