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
  it('does NOT gate when permission_mode is acceptEdits / bypassPermissions / auto / dontAsk', () => {
    for (const mode of ['acceptEdits','bypassPermissions','auto','dontAsk']) {
      expect(shouldGatePreToolUse({ permission_mode: mode, tool_name: 'Bash' }, 'auto'), `mode=${mode}`).toBe(false);
      expect(shouldGatePreToolUse({ permission_mode: mode, tool_name: 'Write' }, 'auto'), `mode=${mode}`).toBe(false);
    }
  });

  it('does NOT gate plan mode (no tool execution anyway)', () => {
    expect(shouldGatePreToolUse({ permission_mode: 'plan', tool_name: 'Write' }, 'auto')).toBe(false);
  });

  it('gates Bash/Edit/Write/MultiEdit/NotebookEdit in default mode', () => {
    for (const tool of ['Bash','Edit','Write','MultiEdit','NotebookEdit']) {
      expect(shouldGatePreToolUse({ permission_mode: 'default', tool_name: tool }, 'auto'), `tool=${tool}`).toBe(true);
    }
  });

  it('does NOT gate Read/Glob/Grep/LS in default mode (claude auto-allows)', () => {
    for (const tool of ['Read','Glob','Grep','LS','Task']) {
      expect(shouldGatePreToolUse({ permission_mode: 'default', tool_name: tool }, 'auto'), `tool=${tool}`).toBe(false);
    }
  });

  it('treats missing permission_mode as default', () => {
    expect(shouldGatePreToolUse({ tool_name: 'Bash' }, 'auto')).toBe(true);
    expect(shouldGatePreToolUse({ tool_name: 'Read' }, 'auto')).toBe(false);
  });
});

describe('shouldGatePreToolUse — disabled policy', () => {
  it('always returns false regardless of mode/tool', () => {
    expect(shouldGatePreToolUse({ permission_mode: 'default', tool_name: 'Bash' }, 'disabled')).toBe(false);
    expect(shouldGatePreToolUse({ permission_mode: 'default', tool_name: 'Write' }, 'disabled')).toBe(false);
  });
});

describe('shouldGatePreToolUse — always policy', () => {
  it('always returns true regardless of mode/tool', () => {
    expect(shouldGatePreToolUse({ permission_mode: 'auto', tool_name: 'Read' }, 'always')).toBe(true);
    expect(shouldGatePreToolUse({ permission_mode: 'bypassPermissions', tool_name: 'Bash' }, 'always')).toBe(true);
  });
});
