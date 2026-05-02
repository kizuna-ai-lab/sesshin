import { describe, it, expect } from 'vitest';
import { mergeUserHooksWithOurs } from './settings-merge.js';

describe('mergeUserHooksWithOurs', () => {
  it('prepends user Stop hooks before ours, preserves matchers', () => {
    const ours = { hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'OURS' }] }] } };
    const userSettings = { hooks: { Stop: [{ matcher: 'tools.*', hooks: [{ type: 'command', command: 'USER' }] }] } };
    const merged = mergeUserHooksWithOurs(ours, userSettings);
    expect(merged.hooks.Stop).toHaveLength(2);
    expect(merged.hooks.Stop[0].hooks[0].command).toBe('USER');
    expect(merged.hooks.Stop[1].hooks[0].command).toBe('OURS');
  });
  it('passes through user keys other than hooks unchanged', () => {
    const ours = { hooks: {} };
    const userSettings = { hooks: {}, model: 'something', mcpServers: { x: 1 } };
    const merged = mergeUserHooksWithOurs(ours, userSettings) as any;
    // Our temp file shouldn't carry user model/mcp/etc — those load from layers Claude reads itself.
    expect(merged).toEqual({ hooks: {} });
  });
});
