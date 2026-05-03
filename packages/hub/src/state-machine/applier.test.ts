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
  it('SubagentStart sets currentTool=Task', () => {
    const bus = new EventBus(); const reg = new SessionRegistry();
    reg.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    reg.updateState('s1', 'running');
    wireStateMachine({ bus, registry: reg });
    bus.emit({ eventId: 'e', sessionId: 's1', kind: 'agent-internal', payload: {}, source: 'observer:hook-ingest', ts: 1, nativeEvent: 'SubagentStart' });
    expect(reg.get('s1')!.substate.currentTool).toBe('Task');
  });
  it('SubagentStop clears currentTool, sets lastTool=Task', () => {
    const bus = new EventBus(); const reg = new SessionRegistry();
    reg.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    reg.updateState('s1', 'running');
    reg.patchSubstate('s1', { currentTool: 'Task' });
    wireStateMachine({ bus, registry: reg });
    bus.emit({ eventId: 'e', sessionId: 's1', kind: 'agent-internal', payload: {}, source: 'observer:hook-ingest', ts: 1, nativeEvent: 'SubagentStop' });
    expect(reg.get('s1')!.substate.currentTool).toBeNull();
    expect(reg.get('s1')!.substate.lastTool).toBe('Task');
  });
  it('PreCompact / PostCompact toggle compacting flag', () => {
    const bus = new EventBus(); const reg = new SessionRegistry();
    reg.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    reg.updateState('s1', 'running');
    wireStateMachine({ bus, registry: reg });
    expect(reg.get('s1')!.substate.compacting).toBe(false);
    bus.emit({ eventId: 'e', sessionId: 's1', kind: 'agent-internal', payload: {}, source: 'observer:hook-ingest', ts: 1, nativeEvent: 'PreCompact' });
    expect(reg.get('s1')!.substate.compacting).toBe(true);
    bus.emit({ eventId: 'e2', sessionId: 's1', kind: 'agent-internal', payload: {}, source: 'observer:hook-ingest', ts: 2, nativeEvent: 'PostCompact' });
    expect(reg.get('s1')!.substate.compacting).toBe(false);
  });
  it('CwdChanged updates substate.cwd from payload', () => {
    const bus = new EventBus(); const reg = new SessionRegistry();
    reg.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/orig', pid: 1, sessionFilePath: '/x' });
    reg.updateState('s1', 'running');
    wireStateMachine({ bus, registry: reg });
    expect(reg.get('s1')!.substate.cwd).toBeNull();
    bus.emit({ eventId: 'e', sessionId: 's1', kind: 'agent-internal', payload: { cwd: '/tmp/new' }, source: 'observer:hook-ingest', ts: 1, nativeEvent: 'CwdChanged' });
    expect(reg.get('s1')!.substate.cwd).toBe('/tmp/new');
    // SessionInfo.cwd unchanged (immutable post-register)
    expect(reg.get('s1')!.cwd).toBe('/orig');
  });
  it('Notification / PermissionDenied are pure event-stream — no substate impact', () => {
    const bus = new EventBus(); const reg = new SessionRegistry();
    reg.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    reg.updateState('s1', 'running');
    reg.patchSubstate('s1', { currentTool: 'Bash' });
    wireStateMachine({ bus, registry: reg });
    const before = JSON.stringify(reg.get('s1')!.substate);
    bus.emit({ eventId: 'e1', sessionId: 's1', kind: 'agent-internal', payload: { message: 'attention' }, source: 'observer:hook-ingest', ts: 1, nativeEvent: 'Notification' });
    bus.emit({ eventId: 'e2', sessionId: 's1', kind: 'agent-internal', payload: { tool_name: 'Bash' }, source: 'observer:hook-ingest', ts: 2, nativeEvent: 'PermissionDenied' });
    expect(JSON.stringify(reg.get('s1')!.substate)).toBe(before);
  });
});
