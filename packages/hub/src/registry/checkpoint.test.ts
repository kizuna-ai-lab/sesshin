import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Checkpoint } from './checkpoint.js';
import { SessionRegistry } from './session-registry.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sesshin-cp-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function reg(): SessionRegistry {
  const r = new SessionRegistry();
  r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/c', pid: 1, sessionFilePath: '/p' });
  return r;
}

describe('Checkpoint', () => {
  it('writes to disk on registry events (debounced)', async () => {
    const r = reg();
    const cp = new Checkpoint(r, { path: join(dir, 'sess.json'), debounceMs: 10 });
    cp.start();
    r.updateState('s1', 'running');
    await new Promise((res) => setTimeout(res, 30));
    expect(existsSync(join(dir, 'sess.json'))).toBe(true);
    const data = JSON.parse(readFileSync(join(dir, 'sess.json'), 'utf-8'));
    expect(data.sessions[0]).toMatchObject({ id: 's1', state: 'running' });
    cp.stop();
  });
  it('load returns empty when no file exists', () => {
    const cp = new Checkpoint(reg(), { path: join(dir, 'absent.json'), debounceMs: 10 });
    expect(cp.load()).toEqual({ sessions: [] });
  });
});
