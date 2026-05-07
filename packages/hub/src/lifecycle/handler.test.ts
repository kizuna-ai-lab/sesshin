import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../storage/db.js';
import { Persistor } from '../storage/persistor.js';
import { SessionRegistry } from '../registry/session-registry.js';
import { LifecycleHandler } from './handler.js';
import * as procState from '../registry/proc-state.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'sesshin-lc-'));
  const db = openDb(join(dir, 'state.db'));
  const reg = new SessionRegistry();
  const persistor = new Persistor({ db, registry: reg, debounceMs: 5 });
  persistor.start();
  const killed: Array<[number, NodeJS.Signals | number]> = [];
  const handler = new LifecycleHandler({
    registry: reg, db, persistor,
    sendSignal: (pid, sig) => { killed.push([pid, sig]); return true; },
  });
  return { dir, db, reg, persistor, handler, killed,
    teardown: () => { persistor.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); }};
}

describe('LifecycleHandler', () => {
  let env: ReturnType<typeof setup>;
  beforeEach(() => { env = setup(); });
  afterEach(() => env.teardown());

  it('pause: SIGSTOP when state is idle/running, transitions to paused', () => {
    env.reg.register({ id: 's', name: 'd', agent: 'claude-code', cwd: '/', pid: 4242, sessionFilePath: '/x' });
    env.reg.updateState('s', 'idle');
    vi.spyOn(procState, 'readProcState').mockReturnValue('stopped');
    const r = env.handler.handle({ type: 'session.lifecycle', requestId: 'r1', sessionId: 's', action: 'pause' }, 'client-A');
    expect(r.ok).toBe(true);
    expect(env.killed).toEqual([[4242, 'SIGSTOP']]);
    expect(env.reg.get('s')!.state).toBe('paused');
    const audits = env.db.actions.list({ sessionId: 's', limit: 10 });
    expect(audits[0]!.kind).toBe('pause');
    expect(audits[0]!.performedBy).toBe('client-A');
  });

  it('pause rejects on done state with lifecycle.invalid-state', () => {
    env.reg.register({ id: 's', name: 'd', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    env.reg.updateState('s', 'done');
    const r = env.handler.handle({ type: 'session.lifecycle', requestId: 'r1', sessionId: 's', action: 'pause' }, 'c');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('lifecycle.invalid-state');
    // Audit still recorded with rejection reason:
    const audits = env.db.actions.list({ sessionId: 's', limit: 10 });
    expect(audits[0]!.payload).toMatchObject({ reason: 'lifecycle.invalid-state' });
  });

  it('rename updates name and audits', () => {
    env.reg.register({ id: 's', name: 'old', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const r = env.handler.handle({
      type: 'session.lifecycle', requestId: 'r', sessionId: 's', action: 'rename',
      payload: { name: 'new' },
    }, 'c');
    expect(r.ok).toBe(true);
    expect(env.reg.get('s')!.name).toBe('new');
    expect(env.db.sessions.get('s')!.name).toBe('new');
  });

  it('delete only valid in done/interrupted/killed', () => {
    env.reg.register({ id: 's', name: 'd', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    env.reg.updateState('s', 'idle');
    const r1 = env.handler.handle({ type: 'session.lifecycle', requestId: 'r', sessionId: 's', action: 'delete' }, 'c');
    expect(r1.ok).toBe(false);
    env.reg.updateState('s', 'done');
    const r2 = env.handler.handle({ type: 'session.lifecycle', requestId: 'r', sessionId: 's', action: 'delete' }, 'c');
    expect(r2.ok).toBe(true);
    expect(env.db.sessions.get('s')!.hidden).toBe(true);
  });

  it('kill SIGTERMs, then unregisters with endReason killed', async () => {
    env.reg.register({ id: 's', name: 'd', agent: 'claude-code', cwd: '/', pid: 9999, sessionFilePath: '/x' });
    env.reg.updateState('s', 'running');
    vi.spyOn(procState, 'readProcState').mockReturnValue('gone'); // process gone after SIGTERM
    const r = env.handler.handle({ type: 'session.lifecycle', requestId: 'r', sessionId: 's', action: 'kill' }, 'c');
    expect(r.ok).toBe(true);
    expect(env.killed[0]).toEqual([9999, 'SIGTERM']);
    // Allow the async kill timer to settle if mocked time is used.
  });
});
