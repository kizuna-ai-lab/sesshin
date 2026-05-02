import { describe, it, expect } from 'vitest';
import { getHandler } from './registry.js';

describe('tool-handler registry', () => {
  it('returns the Bash handler for tool_name="Bash"', () => {
    expect(getHandler('Bash').toolName).toBe('Bash');
  });
  it('returns the file-edit handler for Edit/Write/MultiEdit/NotebookEdit', () => {
    for (const t of ['Edit','Write','MultiEdit','NotebookEdit']) {
      expect(getHandler(t).toolName).toBe('FileEdit');
    }
  });
  it('returns catch-all for unknown tools', () => {
    expect(getHandler('mcp__custom__doStuff').toolName).toBe('CatchAll');
  });
});
