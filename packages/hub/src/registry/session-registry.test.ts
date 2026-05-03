import { describe, it, expect, beforeEach } from 'vitest';
import { SessionRegistry } from './session-registry.js';

function makeReg() { return new SessionRegistry(); }

describe('SessionRegistry', () => {
  it('register assigns a stable id and stores the session', () => {
    const r = makeReg();
    const s = r.register({
      id: 's1', name: 'claude (myproj)', agent: 'claude-code',
      cwd: '/home/me', pid: 1234, sessionFilePath: '/x/s1.jsonl'
    });
    expect(s.id).toBe('s1');
    expect(r.get('s1')).toMatchObject({ id: 's1', state: 'starting' });
  });
  it('unregister returns true on existing id, false on missing', () => {
    const r = makeReg();
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    expect(r.unregister('s1')).toBe(true);
    expect(r.unregister('s1')).toBe(false);
  });
  it('updateState mutates and emits an event', () => {
    const r = makeReg();
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const events: string[] = [];
    r.on('state-changed', (s) => events.push(s.state));
    r.updateState('s1', 'running');
    expect(r.get('s1')?.state).toBe('running');
    expect(events).toEqual(['running']);
  });
  it('list returns a snapshot (mutations to it do not affect the registry)', () => {
    const r = makeReg();
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const snap = r.list();
    snap.length = 0;
    expect(r.list()).toHaveLength(1);
  });
  it('setSessionFilePath updates the path and resets the cursor; returns false when unchanged', () => {
    const r = makeReg();
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x.jsonl' });
    r.setFileCursor('s1', 42);
    expect(r.setSessionFilePath('s1', '/y.jsonl')).toBe(true);
    expect(r.get('s1')?.sessionFilePath).toBe('/y.jsonl');
    expect(r.get('s1')?.fileTailCursor).toBe(0);
    expect(r.setSessionFilePath('s1', '/y.jsonl')).toBe(false);
    expect(r.setSessionFilePath('missing', '/z.jsonl')).toBe(false);
  });
  it('setPermissionMode updates substate, emits substate-changed, idempotent on no-op', () => {
    const r = makeReg();
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const events: string[] = [];
    r.on('substate-changed', (s) => events.push(s.substate.permissionMode));
    expect(r.setPermissionMode('s1', 'auto')).toBe(true);
    expect(r.get('s1')?.substate.permissionMode).toBe('auto');
    expect(r.setPermissionMode('s1', 'auto')).toBe(false); // no-op
    expect(events).toEqual(['auto']);
    expect(r.setPermissionMode('missing', 'plan')).toBe(false);
  });

  it('addSessionAllow appends rules; idempotent on dup', () => {
    const r = makeReg();
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    expect(r.addSessionAllow('s1', 'Bash(git log:*)')).toBe(true);
    expect(r.addSessionAllow('s1', 'Bash(git log:*)')).toBe(false);
    expect(r.get('s1')?.sessionAllowList).toEqual(['Bash(git log:*)']);
    expect(r.addSessionAllow('missing', 'Bash(ls:*)')).toBe(false);
  });

  it('removeSessionAllow drops a rule; returns false if absent or session missing', () => {
    const r = makeReg();
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    r.addSessionAllow('s1', 'Bash(git log:*)');
    expect(r.removeSessionAllow('s1', 'Bash(git log:*)')).toBe(true);
    expect(r.get('s1')?.sessionAllowList).toEqual([]);
    expect(r.removeSessionAllow('s1', 'Bash(git log:*)')).toBe(false);
    expect(r.removeSessionAllow('missing', 'x')).toBe(false);
  });

  it('setSessionGateOverride is read via getSessionGateOverride', () => {
    const r = makeReg();
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    expect(r.getSessionGateOverride('s1')).toBe(null);
    expect(r.setSessionGateOverride('s1', 'always')).toBe(true);
    expect(r.getSessionGateOverride('s1')).toBe('always');
    expect(r.setSessionGateOverride('missing', 'auto')).toBe(false);
    expect(r.getSessionGateOverride('missing')).toBe(null);
  });

  it('pin and quiet round-trip', () => {
    const r = makeReg();
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    expect(r.getPin('s1')).toBe(null);
    expect(r.setPin('s1', 'hello')).toBe(true);
    expect(r.getPin('s1')).toBe('hello');
    expect(r.setPin('s1', null)).toBe(true);
    expect(r.getPin('s1')).toBe(null);
    expect(r.setPin('missing', 'x')).toBe(false);

    expect(r.getQuietUntil('s1')).toBe(null);
    expect(r.setQuietUntil('s1', 1234)).toBe(true);
    expect(r.getQuietUntil('s1')).toBe(1234);
    expect(r.setQuietUntil('s1', null)).toBe(true);
    expect(r.getQuietUntil('s1')).toBe(null);
    expect(r.setQuietUntil('missing', 1)).toBe(false);
  });
});

describe('SessionRegistry — usesPermissionRequest', () => {
  it('newly-registered session has usesPermissionRequest=false', () => {
    const r = makeReg();
    r.register({ id: 's', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    expect(r.get('s')!.usesPermissionRequest).toBe(false);
  });
  it('markUsesPermissionRequest sets the flag and returns true on first call', () => {
    const r = makeReg();
    r.register({ id: 's', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    expect(r.markUsesPermissionRequest('s')).toBe(true);
    expect(r.get('s')!.usesPermissionRequest).toBe(true);
  });
  it('markUsesPermissionRequest returns false when already set (idempotent)', () => {
    const r = makeReg();
    r.register({ id: 's', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    r.markUsesPermissionRequest('s');
    expect(r.markUsesPermissionRequest('s')).toBe(false);
  });
  it('markUsesPermissionRequest returns false when session not registered', () => {
    const r = makeReg();
    expect(r.markUsesPermissionRequest('missing')).toBe(false);
  });
});
