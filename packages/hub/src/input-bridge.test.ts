// packages/hub/src/input-bridge.test.ts
import { describe, it, expect } from 'vitest';
import { InputBridge } from './input-bridge.js';

describe('InputBridge', () => {
  it('deliver invokes the registered sink', async () => {
    const b = new InputBridge();
    const calls: any[] = [];
    b.setSink('s1', async (d, s) => { calls.push([d, s]); });
    const r = await b.deliver('s1', 'y\n', 'remote-adapter:web');
    expect(r.ok).toBe(true);
    expect(calls).toEqual([['y\n','remote-adapter:web']]);
  });
  it('reports session-offline when no sink', async () => {
    const b = new InputBridge();
    const r = await b.deliver('missing', 'x', 'laptop');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('session-offline');
  });
});
