import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tailSessionFile } from './session-file-tail.js';
import { EventBus } from '../event-bus.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sf-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('tailSessionFile', () => {
  it('emits an event for each new line appended', async () => {
    const path = join(dir, 'session.jsonl');
    writeFileSync(path, ''); // start empty
    const bus = new EventBus();
    const events: any[] = [];
    bus.on((e) => events.push(e));
    const stop = tailSessionFile({ sessionId: 's1', path, bus, pollMs: 25 });
    appendFileSync(path, JSON.stringify({ type: 'user', message: { content: 'hi' }, timestamp: 0 }) + '\n');
    await new Promise((r) => setTimeout(r, 80));
    stop();
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].kind).toBe('user-prompt');
  });
  it('handles missing-file → polls until created', async () => {
    const path = join(dir, 'will-create.jsonl');
    const bus = new EventBus();
    const events: any[] = [];
    bus.on((e) => events.push(e));
    const stop = tailSessionFile({ sessionId: 's1', path, bus, pollMs: 25 });
    await new Promise((r) => setTimeout(r, 30));
    writeFileSync(path, JSON.stringify({ type: 'user', message: { content: 'hi' }, timestamp: 0 }) + '\n');
    await new Promise((r) => setTimeout(r, 80));
    stop();
    expect(events.some((e) => e.kind === 'user-prompt')).toBe(true);
  });
});
