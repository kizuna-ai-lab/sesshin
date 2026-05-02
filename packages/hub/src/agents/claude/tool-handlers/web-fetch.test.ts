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
  it('yes-host extracts host', () => {
    const d = webFetchHandler.decide(
      [{ questionIndex: 0, selectedKeys: ['yes-host'] }],
      { url: 'https://example.com/api/x' }, ctx,
    );
    expect(d).toMatchObject({ kind: 'allow', sessionAllowAdd: 'WebFetch(https://example.com/*)' });
  });
});
