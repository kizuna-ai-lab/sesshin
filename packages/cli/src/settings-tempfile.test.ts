import { describe, it, expect } from 'vitest';
import { generateHooksOnlySettings } from './settings-tempfile.js';

describe('generateHooksOnlySettings', () => {
  it('emits only a hooks key', () => {
    const j = JSON.parse(generateHooksOnlySettings({ hookHandlerPath: '/p/handler', sessionId: 's1', hubUrl: 'http://h:1', agent: 'claude-code' }));
    expect(Object.keys(j)).toEqual(['hooks']);
  });
  it('covers the original seven command-hooks plus claude >= 2.1 additions plus PermissionRequest HTTP', () => {
    const j = JSON.parse(generateHooksOnlySettings({ hookHandlerPath: '/p', sessionId: 's', hubUrl: 'h', agent: 'claude-code' }));
    expect(Object.keys(j.hooks).sort()).toEqual([
      'CwdChanged',
      'Notification',
      'PermissionDenied',
      'PermissionRequest',
      'PostCompact',
      'PostToolUse',
      'PostToolUseFailure',
      'PreCompact',
      'PreToolUse',
      'SessionEnd',
      'SessionStart',
      'Stop',
      'StopFailure',
      'SubagentStart',
      'SubagentStop',
      'UserPromptSubmit',
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

describe('generateHooksOnlySettings — PermissionRequest HTTP hook', () => {
  it('emits an HTTP-typed PermissionRequest entry', () => {
    const j = JSON.parse(generateHooksOnlySettings({
      hookHandlerPath: '/usr/local/bin/sesshin-hook-handler',
      sessionId: 'abc123',
      hubUrl: 'http://127.0.0.1:9663',
      agent: 'claude-code',
    }));
    expect(j.hooks.PermissionRequest).toHaveLength(1);
    const entry = j.hooks.PermissionRequest[0].hooks[0];
    expect(entry.type).toBe('http');
    expect(entry.url).toBe('http://127.0.0.1:9663/permission/abc123');
    expect(entry.timeout).toBe(600);
  });
  it('PermissionRequest entry has no matcher key (matcher is meaningless for HTTP hook)', () => {
    const j = JSON.parse(generateHooksOnlySettings({
      hookHandlerPath: '/x', sessionId: 'abc', hubUrl: 'http://h', agent: 'claude-code',
    }));
    expect(j.hooks.PermissionRequest[0].matcher).toBeUndefined();
  });
  it('preserves existing command-hook entries alongside the HTTP hook', () => {
    const j = JSON.parse(generateHooksOnlySettings({
      hookHandlerPath: '/x', sessionId: 'abc', hubUrl: 'http://h', agent: 'claude-code',
    }));
    expect(j.hooks.PreToolUse[0].hooks[0].type).toBe('command');
    expect(j.hooks.SessionStart[0].hooks[0].type).toBe('command');
  });
});
