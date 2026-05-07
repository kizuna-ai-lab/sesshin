import { describe, it, expect } from 'vitest';
import { buildClaudeChildEnv } from './claude.js';

describe('buildClaudeChildEnv: user statusLine propagation', () => {
  it('sets SESSHIN_USER_STATUSLINE_CMD when an inherited command exists', () => {
    const env = buildClaudeChildEnv({
      base: {},
      sessionId: 's1',
      hubUrl: 'http://127.0.0.1:9663',
      inheritedStatusLine: { command: 'my-statusline', padding: 2 },
    });
    expect(env.SESSHIN_USER_STATUSLINE_CMD).toBe('my-statusline');
    // SESSHIN_USER_STATUSLINE_PADDING is intentionally not forwarded (out of scope for v1)
    expect(env.SESSHIN_USER_STATUSLINE_PADDING).toBeUndefined();
  });

  it('omits the env vars when no inherited command exists', () => {
    const env = buildClaudeChildEnv({
      base: {},
      sessionId: 's1',
      hubUrl: 'http://127.0.0.1:9663',
      inheritedStatusLine: null,
    });
    expect(env.SESSHIN_USER_STATUSLINE_CMD).toBeUndefined();
    expect(env.SESSHIN_USER_STATUSLINE_PADDING).toBeUndefined();
  });

  it('never sets SESSHIN_USER_STATUSLINE_PADDING regardless of input padding', () => {
    // padding is preserved in InheritedStatusLine shape but not forwarded via env
    const withoutPadding = buildClaudeChildEnv({
      base: {},
      sessionId: 's1',
      hubUrl: 'http://127.0.0.1:9663',
      inheritedStatusLine: { command: 'just-cmd' },
    });
    expect(withoutPadding.SESSHIN_USER_STATUSLINE_PADDING).toBeUndefined();
    const withPadding = buildClaudeChildEnv({
      base: {},
      sessionId: 's1',
      hubUrl: 'http://127.0.0.1:9663',
      inheritedStatusLine: { command: 'just-cmd', padding: 4 },
    });
    expect(withPadding.SESSHIN_USER_STATUSLINE_PADDING).toBeUndefined();
  });

  it('always sets SESSHIN_SESSION_ID and SESSHIN_HUB_URL', () => {
    const env = buildClaudeChildEnv({
      base: {},
      sessionId: 'abc123',
      hubUrl: 'http://127.0.0.1:9999',
      inheritedStatusLine: null,
    });
    expect(env.SESSHIN_SESSION_ID).toBe('abc123');
    expect(env.SESSHIN_HUB_URL).toBe('http://127.0.0.1:9999');
  });

  it('merges base env vars without overwriting sesshin keys', () => {
    const env = buildClaudeChildEnv({
      base: { MY_CUSTOM_VAR: 'hello', SESSHIN_HUB_URL: 'http://old' },
      sessionId: 's2',
      hubUrl: 'http://127.0.0.1:9663',
      inheritedStatusLine: null,
    });
    expect(env.MY_CUSTOM_VAR).toBe('hello');
    // sesshin keys must win over stale base values
    expect(env.SESSHIN_HUB_URL).toBe('http://127.0.0.1:9663');
    expect(env.SESSHIN_SESSION_ID).toBe('s2');
  });
});
