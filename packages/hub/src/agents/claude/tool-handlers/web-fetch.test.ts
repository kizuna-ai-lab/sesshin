import { describe, it, expect } from 'vitest';
import { webFetchHandler } from './web-fetch.js';

const ctx = { permissionMode: 'default' as const, cwd: '/x', sessionAllowList: [] };

describe('webFetchHandler', () => {
  it('renders URL + host-scoped option', () => {
    const out = webFetchHandler.render({ url: 'https://example.com/api/x' }, ctx);
    expect(out.body).toContain('https://example.com/api/x');
    const keys = out.questions[0]!.options.map(o => o.key);
    expect(keys).toEqual(['yes', 'yes-host', 'no']);
  });
  it('yes-host emits addRules updatedPermissions for the host glob', () => {
    const d = webFetchHandler.decide(
      [{ questionIndex: 0, selectedKeys: ['yes-host'] }],
      { url: 'https://example.com/api/x' }, ctx,
    );
    expect(d).toMatchObject({
      kind: 'allow',
      updatedPermissions: [
        { type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'WebFetch', ruleContent: 'https://example.com/*' }] },
      ],
    });
  });
});
