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
  it('passes session env into each hook entry', () => {
    const j = JSON.parse(generateHooksOnlySettings({ hookHandlerPath: '/p', sessionId: 'SID', hubUrl: 'http://x:9', agent: 'claude-code' }));
    expect(j.hooks.Stop[0].hooks[0].env.SESSHIN_SESSION_ID).toBe('SID');
    expect(j.hooks.Stop[0].hooks[0].env.SESSHIN_HUB_URL).toBe('http://x:9');
    expect(j.hooks.Stop[0].hooks[0].command).toContain('/p');
  });
});
