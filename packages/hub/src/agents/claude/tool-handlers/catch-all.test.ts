import { describe, it, expect } from 'vitest';
import { catchAllHandler, setCatchAllToolName } from './catch-all.js';

const ctx = { permissionMode: 'default' as const, cwd: '/x' };

describe('catchAllHandler', () => {
  it('renders tool name + JSON-stringified input', () => {
    setCatchAllToolName('mcp__custom__doStuff');
    const out = catchAllHandler.render({ x: 1, y: 'hi' }, ctx);
    expect(out.body).toContain('"x": 1');
    const keys = out.questions[0]!.options.map(o => o.key);
    expect(keys).toEqual(['allow', 'allow-this-session:mcp__custom__doStuff', 'deny']);
  });
  it('allow-this-session emits addRules Tool(json) update (tool name baked into the key)', () => {
    setCatchAllToolName('mcp__custom__doStuff');
    const out = catchAllHandler.render({ k: 'v' }, ctx);
    // Find the allow-this-session option key (it carries the tool name)
    const sessionKey = out.questions[0]!.options.find(o => o.key.startsWith('allow-this-session:'))!.key;
    expect(sessionKey).toBe('allow-this-session:mcp__custom__doStuff');
    // Now simulate: user clicks that option for a (later, possibly different) decide call
    const d = catchAllHandler.decide(
      [{ questionIndex: 0, selectedKeys: [sessionKey] }],
      { k: 'v' }, ctx,
    );
    expect(d.kind).toBe('allow');
    if (d.kind === 'allow') {
      expect(d.updatedPermissions).toEqual([
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [{ toolName: 'mcp__custom__doStuff', ruleContent: '{"k":"v"}' }],
        },
      ]);
    }
  });

  it('decide tolerates a different LAST_TOOL_NAME by the time decide is called (concurrent catch-alls)', () => {
    setCatchAllToolName('mcp__server-A__do');
    const a = catchAllHandler.render({ q: 1 }, ctx);
    const aSessionKey = a.questions[0]!.options.find(o => o.key.startsWith('allow-this-session:'))!.key;

    // Concurrent: a different mcp tool arrives, overwrites the module state.
    setCatchAllToolName('mcp__server-B__do');
    // …time passes; user finally answers the FIRST prompt:
    const d = catchAllHandler.decide(
      [{ questionIndex: 0, selectedKeys: [aSessionKey] }],
      { q: 1 }, ctx,
    );
    // Tool name comes from the key, not from LAST_TOOL_NAME — so server-A wins.
    expect(d.kind).toBe('allow');
    if (d.kind === 'allow') {
      expect(d.updatedPermissions).toEqual([
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [{ toolName: 'mcp__server-A__do', ruleContent: '{"q":1}' }],
        },
      ]);
    }
  });
});
