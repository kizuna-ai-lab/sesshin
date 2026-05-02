import { describe, it, expect } from 'vitest';
import { generateHooksOnlySettings } from './settings-tempfile.js';

describe('generateHooksOnlySettings', () => {
  it('emits only a hooks key', () => {
    const j = JSON.parse(generateHooksOnlySettings({ hookHandlerPath: '/p/handler', sessionId: 's1', hubUrl: 'http://h:1', agent: 'claude-code' }));
    expect(Object.keys(j)).toEqual(['hooks']);
  });
  it('covers the seven Claude hook events', () => {
    const j = JSON.parse(generateHooksOnlySettings({ hookHandlerPath: '/p', sessionId: 's', hubUrl: 'h', agent: 'claude-code' }));
    expect(Object.keys(j.hooks).sort()).toEqual([
      'PostToolUse','PreToolUse','SessionEnd','SessionStart','Stop','StopFailure','UserPromptSubmit',
    ]);
  });
  it('bakes session env into the command string via /usr/bin/env (claude ignores the per-hook env field)', () => {
    const j = JSON.parse(generateHooksOnlySettings({ hookHandlerPath: '/p/handler', sessionId: 'SID', hubUrl: 'http://x:9', agent: 'claude-code' }));
    const cmd = j.hooks.Stop[0].hooks[0].command;
    expect(cmd).toContain('/usr/bin/env');
    expect(cmd).toContain('SESSHIN_SESSION_ID=SID');
    expect(cmd).toContain('SESSHIN_HUB_URL=http://x:9');
    expect(cmd).toContain('SESSHIN_AGENT=claude-code');
    expect(cmd).toContain('/p/handler Stop');
    // No `env` field — it is silently ignored by claude.
    expect(j.hooks.Stop[0].hooks[0].env).toBeUndefined();
  });
});
