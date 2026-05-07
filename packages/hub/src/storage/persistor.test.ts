import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from './db.js';
import { Persistor } from './persistor.js';
import { SessionRegistry } from '../registry/session-registry.js';

describe('Persistor', () => {
  let dir: string;
  let db: Db;
  let reg: SessionRegistry;
  let p: Persistor;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sesshin-pers-'));
    db = openDb(join(dir, 'state.db'));
    reg = new SessionRegistry();
    p = new Persistor({ db, registry: reg, debounceMs: 5 });
    p.start();
  });
  afterEach(() => {
    p.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('inserts a row on session-added', () => {
    reg.register({ id: 's1', name: 'demo', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const row = db.sessions.get('s1');
    expect(row).not.toBeNull();
    expect(row!.lastState).toBe('starting');
    expect(row!.endedAt).toBeNull();
  });

  it('debounces state changes into a single UPDATE', async () => {
    reg.register({ id: 's2', name: 'demo', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    reg.updateState('s2', 'running');
    reg.updateState('s2', 'idle');
    reg.updateState('s2', 'running');
    await new Promise((r) => setTimeout(r, 30));
    expect(db.sessions.get('s2')!.lastState).toBe('running');
  });

  it('marks ended on unregister with provided reason', () => {
    reg.register({ id: 's3', name: 'd', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    p.markEnded('s3', { endReason: 'killed', lastState: 'killed' });
    reg.unregister('s3');
    const row = db.sessions.get('s3')!;
    expect(row.endedAt).not.toBeNull();
    expect(row.endReason).toBe('killed');
    expect(row.lastState).toBe('killed');
  });

  it('flushes pending writes on stop()', async () => {
    reg.register({ id: 's4', name: 'd', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    reg.patchSubstate('s4', { stalled: true });
    p.stop();
    expect(JSON.stringify(db.sessions.get('s4')!.metadata)).toContain('"stalled":true');
  });

  it('falls back to endReason="normal" / lastState="done" if markEnded was not called', () => {
    reg.register({ id: 's5', name: 'd', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    reg.unregister('s5');
    const row = db.sessions.get('s5')!;
    expect(row.endedAt).not.toBeNull();
    expect(row.endReason).toBe('normal');
    expect(row.lastState).toBe('done');
  });
});
