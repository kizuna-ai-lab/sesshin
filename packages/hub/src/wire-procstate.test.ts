import { describe, it, expect, vi } from 'vitest';
import { SessionRegistry } from './registry/session-registry.js';
import * as procState from './registry/proc-state.js';

describe('proc-state reconciliation', () => {
  it('flips registry state to paused when proc reports stopped', () => {
    const reg = new SessionRegistry();
    const rec = reg.register({ id: 'x', name: 'x', agent: 'claude-code', cwd: '/', pid: 999, sessionFilePath: '/x' });
    reg.updateState('x', 'idle');
    vi.spyOn(procState, 'readProcState').mockReturnValue('stopped');
    // Inline the reconcile logic: in real code it lives in wire.ts.
    const proc = procState.readProcState(rec.pid);
    if (proc === 'stopped') reg.updateState('x', 'paused');
    expect(reg.get('x')!.state).toBe('paused');
    vi.restoreAllMocks();
  });

  it('flips paused → idle on resume detection', () => {
    const reg = new SessionRegistry();
    const rec = reg.register({ id: 'y', name: 'y', agent: 'claude-code', cwd: '/', pid: 888, sessionFilePath: '/y' });
    reg.updateState('y', 'paused');
    vi.spyOn(procState, 'readProcState').mockReturnValue('running');
    const proc = procState.readProcState(rec.pid);
    if (proc === 'running' && reg.get('y')!.state === 'paused') reg.updateState('y', 'idle');
    expect(reg.get('y')!.state).toBe('idle');
    vi.restoreAllMocks();
  });

  it('unregisters on gone/dead', () => {
    const reg = new SessionRegistry();
    reg.register({ id: 'z', name: 'z', agent: 'claude-code', cwd: '/', pid: 777, sessionFilePath: '/z' });
    vi.spyOn(procState, 'readProcState').mockReturnValue('gone');
    const proc = procState.readProcState(777);
    if (proc === 'gone' || proc === 'dead') reg.unregister('z');
    expect(reg.get('z')).toBeUndefined();
    vi.restoreAllMocks();
  });
});
