import { describe, it, expect } from 'vitest';
import { parsePolicy, shouldGatePreToolUse } from './approval-policy.js';

describe('parsePolicy', () => {
  it('defaults to auto when env is unset', () => { expect(parsePolicy(undefined)).toBe('auto'); });
  it('parses common synonyms', () => {
    expect(parsePolicy('disabled')).toBe('disabled');
    expect(parsePolicy('off')).toBe('disabled');
    expect(parsePolicy('never')).toBe('disabled');
    expect(parsePolicy('always')).toBe('always');
    expect(parsePolicy('AUTO')).toBe('auto');
    expect(parsePolicy('weird')).toBe('auto'); // safe default
  });
});

describe('shouldGatePreToolUse — auto policy', () => {
  it('does NOT gate when knownMode is auto even if hook says default', () => {
    expect(shouldGatePreToolUse(
      { permission_mode: 'default', tool_name: 'Bash' },
      'auto',          // knownMode
      'auto',          // policy
    )).toBe(false);
  });

  it('gates when knownMode is default and tool is gated', () => {
    expect(shouldGatePreToolUse(
      { permission_mode: 'default', tool_name: 'Bash' },
      'default', 'auto',
    )).toBe(true);
  });

  it('falls back to raw permission_mode when knownMode is undefined', () => {
    expect(shouldGatePreToolUse(
      { permission_mode: 'acceptEdits', tool_name: 'Bash' },
      undefined, 'auto',
    )).toBe(false);
  });

  it('does NOT gate when permission_mode is acceptEdits / bypassPermissions / auto / dontAsk', () => {
    for (const mode of ['acceptEdits','bypassPermissions','auto','dontAsk']) {
      expect(shouldGatePreToolUse({ permission_mode: mode, tool_name: 'Bash' }, undefined, 'auto'), `mode=${mode}`).toBe(false);
      expect(shouldGatePreToolUse({ permission_mode: mode, tool_name: 'Write' }, undefined, 'auto'), `mode=${mode}`).toBe(false);
    }
  });

  it('does NOT gate plan mode (no tool execution anyway)', () => {
    expect(shouldGatePreToolUse({ permission_mode: 'plan', tool_name: 'Write' }, undefined, 'auto')).toBe(false);
  });

  it('gates Bash/Edit/Write/MultiEdit/NotebookEdit in default mode', () => {
    for (const tool of ['Bash','Edit','Write','MultiEdit','NotebookEdit']) {
      expect(shouldGatePreToolUse({ permission_mode: 'default', tool_name: tool }, undefined, 'auto'), `tool=${tool}`).toBe(true);
    }
  });

  it('does NOT gate Read/Glob/Grep/LS in default mode (claude auto-allows)', () => {
    for (const tool of ['Read','Glob','Grep','LS','Task']) {
      expect(shouldGatePreToolUse({ permission_mode: 'default', tool_name: tool }, undefined, 'auto'), `tool=${tool}`).toBe(false);
    }
  });

  it('gates the full v1.5 GATED_TOOLS list in default mode', () => {
    const tools = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
                   'PowerShell', 'WebFetch', 'AskUserQuestion',
                   'ExitPlanMode', 'EnterPlanMode', 'Skill'];
    for (const tool of tools) {
      expect(shouldGatePreToolUse({ permission_mode: 'default', tool_name: tool }, undefined, 'auto'), `tool=${tool}`).toBe(true);
    }
  });

  it('gates mcp__* tools in default mode', () => {
    expect(shouldGatePreToolUse({ permission_mode: 'default', tool_name: 'mcp__github__createPR' }, undefined, 'auto')).toBe(true);
    expect(shouldGatePreToolUse({ permission_mode: 'default', tool_name: 'mcp__custom__doStuff' }, undefined, 'auto')).toBe(true);
  });

  it('does NOT gate non-mcp tools that arent in GATED_TOOLS', () => {
    expect(shouldGatePreToolUse({ permission_mode: 'default', tool_name: 'Read' }, undefined, 'auto')).toBe(false);
    expect(shouldGatePreToolUse({ permission_mode: 'default', tool_name: 'Glob' }, undefined, 'auto')).toBe(false);
    expect(shouldGatePreToolUse({ permission_mode: 'default', tool_name: 'mcpfake' }, undefined, 'auto')).toBe(false);
  });

  it('treats missing permission_mode as default', () => {
    expect(shouldGatePreToolUse({ tool_name: 'Bash' }, undefined, 'auto')).toBe(true);
    expect(shouldGatePreToolUse({ tool_name: 'Read' }, undefined, 'auto')).toBe(false);
  });

  it('does NOT gate when tool matches sessionAllowList', () => {
    expect(shouldGatePreToolUse(
      { permission_mode: 'default', tool_name: 'Bash', tool_input: { command: 'git log --oneline' } },
      'default', 'auto',
      { sessionAllowList: ['Bash(git log:*)'], claudeAllowRules: [] },
    )).toBe(false);
  });
  it('does NOT gate when tool matches claudeAllowRules', () => {
    expect(shouldGatePreToolUse(
      { permission_mode: 'default', tool_name: 'Bash', tool_input: { command: 'npm install' } },
      'default', 'auto',
      { sessionAllowList: [], claudeAllowRules: ['Bash(npm install)'] },
    )).toBe(false);
  });

  it('does NOT gate when no client subscribed even if everything else is gated', () => {
    expect(shouldGatePreToolUse(
      { permission_mode: 'default', tool_name: 'Bash' },
      'default', 'auto',
      { sessionAllowList: [], claudeAllowRules: [] },
      /* hasSubscribedClient */ false,
    )).toBe(false);
  });

  it('still gates when hasSubscribedClient is true (explicit)', () => {
    expect(shouldGatePreToolUse(
      { permission_mode: 'default', tool_name: 'Bash' },
      'default', 'auto',
      { sessionAllowList: [], claudeAllowRules: [] },
      /* hasSubscribedClient */ true,
    )).toBe(true);
  });
});

describe('shouldGatePreToolUse — disabled policy', () => {
  it('always returns false regardless of mode/tool', () => {
    expect(shouldGatePreToolUse({ permission_mode: 'default', tool_name: 'Bash' }, undefined, 'disabled')).toBe(false);
    expect(shouldGatePreToolUse({ permission_mode: 'default', tool_name: 'Write' }, undefined, 'disabled')).toBe(false);
  });
});

describe('shouldGatePreToolUse — always policy', () => {
  it('always returns true regardless of mode/tool', () => {
    expect(shouldGatePreToolUse({ permission_mode: 'auto', tool_name: 'Read' }, undefined, 'always')).toBe(true);
    expect(shouldGatePreToolUse({ permission_mode: 'bypassPermissions', tool_name: 'Bash' }, undefined, 'always')).toBe(true);
  });
});

describe('shouldGatePreToolUse — usesPermissionRequest short-circuit', () => {
  it('returns false when usesPermissionRequest=true regardless of mode/tool/policy', () => {
    expect(shouldGatePreToolUse(
      { tool_name: 'Bash', tool_input: { command: 'ls' }, permission_mode: 'default' },
      'default',
      'always',
      { sessionAllowList: [], claudeAllowRules: [] },
      true,
      true,
    )).toBe(false);
  });
  it('returns false even with policy=always and gated tool', () => {
    expect(shouldGatePreToolUse(
      { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } },
      'default',
      'always',
      { sessionAllowList: [], claudeAllowRules: [] },
      true,
      true,
    )).toBe(false);
  });
  it('default usesPermissionRequest=false preserves existing behavior', () => {
    expect(shouldGatePreToolUse(
      { tool_name: 'Bash', tool_input: { command: 'ls' } },
      'default',
      'auto',
      { sessionAllowList: [], claudeAllowRules: [] },
      true,
    )).toBe(true);
  });
});
