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

  it('yes-session-scope emits addRules updatedPermissions for the dir glob', () => {
    const d = fileEditHandler.decide(
      [{ questionIndex: 0, selectedKeys: ['yes-session-scope'] }],
      { file_path: '/proj/src/foo.ts' }, ctx,
    );
    expect(d).toMatchObject({
      kind: 'allow',
      updatedPermissions: [
        { type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Edit', ruleContent: '/proj/src/*' }] },
      ],
    });
  });

  it('no with freeText becomes deny + additionalContext', () => {
    const d = fileEditHandler.decide(
      [{ questionIndex: 0, selectedKeys: ['no'], freeText: 'edit a different file' }],
      { file_path: '/proj/x.ts' }, ctx,
    );
    expect(d).toEqual({ kind: 'deny', additionalContext: 'edit a different file' });
  });
});
