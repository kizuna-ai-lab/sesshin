import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './storage/db.js';
import { Persistor } from './storage/persistor.js';
import { SessionRegistry } from './registry/session-registry.js';

describe('integration: persist + restore', () => {
  it('keeps lastState and metadata across hub restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sesshin-int-'));
    const path = join(dir, 'state.db');
    {
      const db = openDb(path);
      const reg = new SessionRegistry();
      const p = new Persistor({ db, registry: reg, debounceMs: 5 });
      p.start();
      reg.register({ id: 's', name: 'demo', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
      reg.updateState('s', 'running');
      reg.patchSubstate('s', { stalled: true });
      await new Promise((r) => setTimeout(r, 20));
      p.stop();
      db.close();
    }
    {
      const db = openDb(path);
      const row = db.sessions.get('s')!;
      expect(row.lastState).toBe('running');
      expect((row.metadata as { substate?: { stalled?: boolean } }).substate?.stalled).toBe(true);
      db.close();
    }
    rmSync(dir, { recursive: true, force: true });
  });
});
