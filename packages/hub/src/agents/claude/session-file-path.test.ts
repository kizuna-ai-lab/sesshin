import { describe, it, expect } from 'vitest';
import { encodeCwdForClaudeProjects, sessionFilePath } from './session-file-path.js';

describe('encodeCwdForClaudeProjects', () => {
  it('replaces / with - in normal paths', () => {
    expect(encodeCwdForClaudeProjects('/home/me/proj')).toBe('-home-me-proj');
  });
  it('replaces . with - in dotfile-prefixed segments', () => {
    expect(encodeCwdForClaudeProjects('/home/me/.config')).toBe('-home-me--config');
  });
  it('preserves hyphens in segment names', () => {
    expect(encodeCwdForClaudeProjects('/home/me/sokuji-react')).toBe('-home-me-sokuji-react');
  });
  it('combines / and . encoding', () => {
    expect(encodeCwdForClaudeProjects('/x/.claude/worktrees')).toBe('-x--claude-worktrees');
  });
});

describe('sessionFilePath', () => {
  it('joins projects/<encoded>/<session>.jsonl under home', () => {
    const p = sessionFilePath({ home: '/h', cwd: '/home/me/proj', sessionId: 'abc' });
    expect(p).toBe('/h/.claude/projects/-home-me-proj/abc.jsonl');
  });
});
