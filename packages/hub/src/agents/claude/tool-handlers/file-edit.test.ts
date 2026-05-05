import { describe, it, expect } from 'vitest';
import { fileEditHandler } from './file-edit.js';

const ctx = { permissionMode: 'default' as const, cwd: '/proj' };

describe('fileEditHandler', () => {
  it('renders body with file_path + 3 options', () => {
    const out = fileEditHandler.render({ file_path: '/tmp/a.md', content: 'hello' }, ctx);
    expect(out.origin).toBe('permission');
    expect(out.body).toContain('/tmp/a.md');
    const keys = out.questions[0]!.options.map(o => o.key);
    expect(keys).toEqual(['yes', 'yes-session-scope', 'no']);
  });

  it('yes-session-scope emits addRules updatedPermissions for all edit-class tools', () => {
    const d = fileEditHandler.decide(
      [{ questionIndex: 0, selectedKeys: ['yes-session-scope'] }],
      { file_path: '/proj/src/foo.ts' }, ctx,
    );
    expect(d).toMatchObject({ kind: 'allow' });
    expect(d.updatedPermissions).toEqual([
      { type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Edit', ruleContent: '/proj/src/*' }] },
      { type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Write', ruleContent: '/proj/src/*' }] },
      { type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'MultiEdit', ruleContent: '/proj/src/*' }] },
      { type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'NotebookEdit', ruleContent: '/proj/src/*' }] },
    ]);
  });

  it('yes-session-scope without file_path does not persist a wildcard rule', () => {
    const d = fileEditHandler.decide(
      [{ questionIndex: 0, selectedKeys: ['yes-session-scope'] }],
      {}, ctx,
    );
    expect(d).toEqual({ kind: 'allow' });
  });

  it('yes-session-scope with dirname(.) does not persist a wildcard rule', () => {
    const d = fileEditHandler.decide(
      [{ questionIndex: 0, selectedKeys: ['yes-session-scope'] }],
      { file_path: 'foo.ts' }, ctx,
    );
    expect(d).toEqual({ kind: 'allow' });
  });

  it('no with freeText becomes deny + additionalContext', () => {
    const d = fileEditHandler.decide(
      [{ questionIndex: 0, selectedKeys: ['no'], freeText: 'edit a different file' }],
      { file_path: '/proj/x.ts' }, ctx,
    );
    expect(d).toEqual({ kind: 'deny', additionalContext: 'edit a different file' });
  });
});
