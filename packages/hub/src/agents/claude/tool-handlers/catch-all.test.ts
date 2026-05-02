import { describe, it, expect } from 'vitest';
import { catchAllHandler, setCatchAllToolName } from './catch-all.js';

const ctx = { permissionMode: 'default' as const, cwd: '/x', sessionAllowList: [] };

describe('catchAllHandler', () => {
  it('renders tool name + JSON-stringified input', () => {
    setCatchAllToolName('mcp__custom__doStuff');
    const out = catchAllHandler.render({ x: 1, y: 'hi' }, ctx);
    expect(out.body).toContain('"x": 1');
    const keys = out.questions[0]!.options.map(o => o.key);
    expect(keys).toEqual(['allow', 'allow-this-session', 'deny']);
  });
  it('allow-this-session adds Tool(json) entry', () => {
    setCatchAllToolName('mcp__custom__doStuff');
    const d = catchAllHandler.decide(
      [{ questionIndex: 0, selectedKeys: ['allow-this-session'] }],
      { k: 'v' }, ctx,
    );
    expect(d.kind).toBe('allow');
    if (d.kind === 'allow') expect(d.sessionAllowAdd).toContain('"k":"v"');
  });
});
