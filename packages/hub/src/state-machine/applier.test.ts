import { describe, it, expect } from 'vitest';
import { wireStateMachine } from './applier.js';
import { EventBus } from '../event-bus.js';
import { SessionRegistry } from '../registry/session-registry.js';

describe('wireStateMachine', () => {
  it('user-prompt drives idle → running and resets elapsedSinceProgressMs', () => {
    const bus = new EventBus(); const reg = new SessionRegistry();
    reg.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    reg.updateState('s1', 'idle');
    reg.patchSubstate('s1', { elapsedSinceProgressMs: 9999 });
    wireStateMachine({ bus, registry: reg });
    bus.emit({ eventId: 'e', sessionId: 's1', kind: 'user-prompt', payload: {}, source: 'observer:hook-ingest', ts: 1 });
    expect(reg.get('s1')!.state).toBe('running');
    expect(reg.get('s1')!.substate.elapsedSinceProgressMs).toBe(0);
  });
  it('tool-call updates currentTool', () => {
    const bus = new EventBus(); const reg = new SessionRegistry();
    reg.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    reg.updateState('s1', 'running');
    wireStateMachine({ bus, registry: reg });
    bus.emit({ eventId: 'e', sessionId: 's1', kind: 'tool-call', payload: { tool: 'Edit' }, source: 'observer:hook-ingest', ts: 1 });
    expect(reg.get('s1')!.substate.currentTool).toBe('Edit');
  });
  it('tool-result records lastTool, clears currentTool', () => {
    const bus = new EventBus(); const reg = new SessionRegistry();
    reg.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    reg.updateState('s1', 'running');
    reg.patchSubstate('s1', { currentTool: 'Read' });
    wireStateMachine({ bus, registry: reg });
    bus.emit({ eventId: 'e', sessionId: 's1', kind: 'tool-result', payload: { tool: 'Read' }, source: 'observer:hook-ingest', ts: 1 });
    expect(reg.get('s1')!.substate.currentTool).toBeNull();
    expect(reg.get('s1')!.substate.lastTool).toBe('Read');
  });
});
