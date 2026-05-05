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

describe('SessionRegistry — publicView surfaces sessionFilePath', () => {
  it('list() includes sessionFilePath when non-empty', () => {
    const r = makeReg();
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/path/to/transcript.jsonl' });
    expect(r.list()[0]!.sessionFilePath).toBe('/path/to/transcript.jsonl');
  });
  it('list() omits sessionFilePath when empty (placeholder not yet replaced by SessionStart)', () => {
    const r = makeReg();
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '' });
    expect(r.list()[0]!.sessionFilePath).toBeUndefined();
  });
  it('emitted session-added view also surfaces it', () => {
    const r = makeReg();
    let captured: { sessionFilePath?: string | undefined; claudeSessionId: string | null } = { claudeSessionId: null };
    r.on('session-added', (s) => { captured = s; });
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/p.jsonl' });
    expect(captured.sessionFilePath).toBe('/p.jsonl');
  });
  it('publicView does NOT leak claudeAllowRules / sessionAllowList / usesPermissionRequest / etc.', () => {
    const r = makeReg();
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/p.jsonl' });
    const view = r.list()[0] as Record<string, unknown>;
    expect('claudeAllowRules' in view).toBe(false);
    expect('sessionAllowList' in view).toBe(false);
    expect('usesPermissionRequest' in view).toBe(false);
    expect('lastHeartbeat' in view).toBe(false);
    expect('fileTailCursor' in view).toBe(false);
    // pin, quietUntil, sessionGateOverride are now surfaced in publicView:
    expect('pin' in view).toBe(true);
    expect('quietUntil' in view).toBe(true);
    expect('sessionGateOverride' in view).toBe(true);
  });
});

describe('publicView and config-changed event', () => {
  function fixtureRegistry(): SessionRegistry {
    const r = new SessionRegistry();
    r.register({
      id: 's1', name: 'n', agent: 'claude-code', cwd: '/x', pid: 1, sessionFilePath: '/x/s1.jsonl'
    });
    return r;
  }

  it('publicView includes pin/quietUntil/sessionGateOverride after register', () => {
    const r = fixtureRegistry();
    const s = r.list()[0]!;
    expect(s.pin).toBeNull();
    expect(s.quietUntil).toBeNull();
    expect(s.sessionGateOverride).toBeNull();
  });

  it('setPin emits config-changed with the new pin in the snapshot', () => {
    const r = fixtureRegistry();
    const id = r.list()[0]!.id;
    const events: any[] = [];
    r.on('config-changed', (info) => events.push(info));
    r.setPin(id, 'deploy');
    expect(events).toHaveLength(1);
    expect(events[0]!.pin).toBe('deploy');
    expect(events[0]!.quietUntil).toBeNull();
    expect(events[0]!.sessionGateOverride).toBeNull();
  });

  it('setPin to the same value does not emit', () => {
    const r = fixtureRegistry();
    const id = r.list()[0]!.id;
    r.setPin(id, 'x');
    const events: any[] = [];
    r.on('config-changed', (info) => events.push(info));
    r.setPin(id, 'x');
    expect(events).toHaveLength(0);
  });

  it('setPin null→null does not emit', () => {
    const r = fixtureRegistry();
    const id = r.list()[0]!.id;
    const events: any[] = [];
    r.on('config-changed', (info) => events.push(info));
    r.setPin(id, null);
    expect(events).toHaveLength(0);
  });

  it('setQuietUntil emits + no-op short-circuit', () => {
    const r = fixtureRegistry();
    const id = r.list()[0]!.id;
    const events: any[] = [];
    r.on('config-changed', (info) => events.push(info));
    r.setQuietUntil(id, 1700000000000);
    r.setQuietUntil(id, 1700000000000);
    expect(events).toHaveLength(1);
    expect(events[0]!.quietUntil).toBe(1700000000000);
  });

  it('setSessionGateOverride emits + no-op short-circuit', () => {
    const r = fixtureRegistry();
    const id = r.list()[0]!.id;
    const events: any[] = [];
    r.on('config-changed', (info) => events.push(info));
    r.setSessionGateOverride(id, 'always');
    r.setSessionGateOverride(id, 'always');
    expect(events).toHaveLength(1);
    expect(events[0]!.sessionGateOverride).toBe('always');
  });

  it('config-changed payload does not contain stripped private fields', () => {
    const r = fixtureRegistry();
    const id = r.list()[0]!.id;
    let captured: any = null;
    r.on('config-changed', (info) => { captured = info; });
    r.setPin(id, 'x');
    expect(captured).not.toBeNull();
    expect('claudeAllowRules' in captured).toBe(false);
    expect('sessionAllowList' in captured).toBe(false);
    expect('usesPermissionRequest' in captured).toBe(false);
  });

  it('setPin on unknown session returns false and does not emit', () => {
    const r = new SessionRegistry();
    const events: any[] = [];
    r.on('config-changed', (info) => events.push(info));
    expect(r.setPin('nonexistent', 'x')).toBe(false);
    expect(events).toHaveLength(0);
  });
});

describe('claudeSessionId tracking', () => {
  it('starts null', () => {
    const r = new SessionRegistry();
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '' });
    expect(r.get('s1')?.claudeSessionId).toBeNull();
  });

  it('setClaudeSessionId returns true on change, false on no-op or unknown', () => {
    const r = new SessionRegistry();
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '' });
    expect(r.setClaudeSessionId('s1', 'cc-1')).toBe(true);
    expect(r.setClaudeSessionId('s1', 'cc-1')).toBe(false);
    expect(r.setClaudeSessionId('s1', 'cc-2')).toBe(true);
    expect(r.get('s1')?.claudeSessionId).toBe('cc-2');
    expect(r.setClaudeSessionId('unknown', 'cc-x')).toBe(false);
  });

  it('clearClaudeSessionId returns true only when going non-null → null', () => {
    const r = new SessionRegistry();
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '' });
    // No-op when already null
    expect(r.clearClaudeSessionId('s1')).toBe(false);
    r.setClaudeSessionId('s1', 'cc-1');
    expect(r.clearClaudeSessionId('s1')).toBe(true);
    expect(r.get('s1')?.claudeSessionId).toBeNull();
    // No-op on unknown session
    expect(r.clearClaudeSessionId('unknown')).toBe(false);
  });

  it('emits config-changed when claudeSessionId changes', () => {
    const r = new SessionRegistry();
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '' });
    let calls = 0;
    r.on('config-changed', () => { calls++; });
    r.setClaudeSessionId('s1', 'cc-1');
    expect(calls).toBe(1);
    r.setClaudeSessionId('s1', 'cc-1'); // no-op
    expect(calls).toBe(1);
    r.clearClaudeSessionId('s1');
    expect(calls).toBe(2);
  });

  it('publicView surfaces claudeSessionId after setClaudeSessionId', () => {
    const r = new SessionRegistry();
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    r.setClaudeSessionId('s1', 'cc-1');
    const view = r.list().find((s) => s.id === 's1')!;
    expect(view.claudeSessionId).toBe('cc-1');
  });
});

describe('resetChildScopedState', () => {
  it('clears fileTailCursor and lastSummaryId', () => {
    const r = new SessionRegistry();
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    r.setFileCursor('s1', 999);
    r.setLastSummary('s1', 'sum-1');
    r.resetChildScopedState('s1');
    const rec = r.get('s1');
    expect(rec?.fileTailCursor).toBe(0);
    expect(rec?.lastSummaryId).toBeNull();
  });

  it('keeps parent-scoped state (pin, quietUntil, sessionGateOverride, claudeAllowRules)', () => {
    const r = new SessionRegistry();
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    r.setPin('s1', 'note');
    r.setQuietUntil('s1', 12345);
    r.setSessionGateOverride('s1', 'always');
    r.setClaudeAllowRules('s1', ['Bash(git:*)']);
    r.resetChildScopedState('s1');
    const rec = r.get('s1');
    expect(rec?.pin).toBe('note');
    expect(rec?.quietUntil).toBe(12345);
    expect(rec?.sessionGateOverride).toBe('always');
    expect(rec?.claudeAllowRules).toEqual(['Bash(git:*)']);
  });

  it('does not touch sessionFilePath', () => {
    const r = new SessionRegistry();
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/some/transcript.jsonl' });
    r.resetChildScopedState('s1');
    expect(r.get('s1')?.sessionFilePath).toBe('/some/transcript.jsonl');
  });

  it('no-op on unknown session', () => {
    const r = new SessionRegistry();
    expect(() => r.resetChildScopedState('unknown')).not.toThrow();
  });
});
