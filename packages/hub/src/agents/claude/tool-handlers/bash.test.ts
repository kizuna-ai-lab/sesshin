import { describe, it, expect } from 'vitest';
import { bashHandler } from './bash.js';

const ctx = { permissionMode: 'default' as const, cwd: '/x', sessionAllowList: [] };

describe('bashHandler', () => {
  it('renders the command in a fenced bash block + 3 options', () => {
    const out = bashHandler.render({ command: 'git log --oneline' }, ctx);
    expect(out.origin).toBe('permission');
    expect(out.body).toContain('```bash\ngit log --oneline\n```');
    expect(out.questions).toHaveLength(1);
    const opts = out.questions[0]!.options.map(o => o.key);
    expect(opts).toEqual(['yes', 'yes-prefix', 'no']);
  });

  it('decide(yes) → allow', () => {
    const d = bashHandler.decide([{ questionIndex: 0, selectedKeys: ['yes'] }], { command: 'ls' }, ctx);
    expect(d).toEqual({ kind: 'allow' });
  });

  it('decide(no, freeText) → deny + additionalContext', () => {
    const d = bashHandler.decide(
      [{ questionIndex: 0, selectedKeys: ['no'], freeText: 'use grep instead' }],
      { command: 'ls' }, ctx,
    );
    expect(d).toEqual({ kind: 'deny', additionalContext: 'use grep instead' });
  });

  it('decide(yes-prefix, freeText) → allow + addRules updatedPermissions', () => {
    const d = bashHandler.decide(
      [{ questionIndex: 0, selectedKeys: ['yes-prefix'], freeText: 'npm run:*' }],
      { command: 'npm run build' }, ctx,
    );
    expect(d).toMatchObject({
      kind: 'allow',
      updatedPermissions: [
        { type: 'addRules', behavior: 'allow', destination: 'session', rules: ['Bash(npm run:*)'] },
      ],
    });
  });

  it('decide(yes-prefix, no freeText) → allow + heuristic prefix from command', () => {
    const d = bashHandler.decide(
      [{ questionIndex: 0, selectedKeys: ['yes-prefix'] }],
      { command: 'git log --oneline' }, ctx,
    );
    expect(d).toMatchObject({
      kind: 'allow',
      updatedPermissions: [
        { type: 'addRules', behavior: 'allow', destination: 'session', rules: ['Bash(git log:*)'] },
      ],
    });
  });

  it('decide() with no selectedKeys falls through to ask', () => {
    const d = bashHandler.decide([{ questionIndex: 0, selectedKeys: [] }], { command: 'ls' }, ctx);
    expect(d).toEqual({ kind: 'ask' });
  });

  it('decide() with no answers falls through to ask', () => {
    const d = bashHandler.decide([], { command: 'ls' }, ctx);
    expect(d).toEqual({ kind: 'ask' });
  });
});
