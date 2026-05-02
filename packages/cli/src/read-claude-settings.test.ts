import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClaudeSettings } from './read-claude-settings.js';

let HOME: string, CWD: string;
beforeEach(() => {
  HOME = mkdtempSync(join(tmpdir(), 'sesshin-test-home-'));
  CWD  = mkdtempSync(join(tmpdir(), 'sesshin-test-cwd-'));
});
afterEach(() => {
  if (HOME) rmSync(HOME, { recursive: true, force: true });
  if (CWD)  rmSync(CWD,  { recursive: true, force: true });
});

describe('readClaudeSettings', () => {
  it('returns empty defaults when no settings exist', () => {
    expect(readClaudeSettings({ home: HOME, cwd: CWD })).toEqual({ defaultMode: null, allowRules: [] });
  });

  it('reads user defaultMode from ~/.claude/settings.json', () => {
    mkdirSync(join(HOME, '.claude'), { recursive: true });
    writeFileSync(join(HOME, '.claude/settings.json'),
      JSON.stringify({ permissions: { defaultMode: 'auto', allow: ['Bash(git log:*)'] } }));
    expect(readClaudeSettings({ home: HOME, cwd: CWD })).toEqual({
      defaultMode: 'auto', allowRules: ['Bash(git log:*)'],
    });
  });

  it('project settings override user defaultMode and merge allow rules', () => {
    mkdirSync(join(HOME, '.claude'), { recursive: true });
    writeFileSync(join(HOME, '.claude/settings.json'),
      JSON.stringify({ permissions: { defaultMode: 'auto', allow: ['Bash(git log:*)'] } }));
    mkdirSync(join(CWD, '.claude'), { recursive: true });
    writeFileSync(join(CWD, '.claude/settings.json'),
      JSON.stringify({ permissions: { defaultMode: 'default', allow: ['Edit(/tmp/*)'] } }));
    expect(readClaudeSettings({ home: HOME, cwd: CWD })).toEqual({
      defaultMode: 'default',
      allowRules: ['Bash(git log:*)', 'Edit(/tmp/*)'],
    });
  });

  it('tolerates malformed JSON', () => {
    mkdirSync(join(HOME, '.claude'), { recursive: true });
    writeFileSync(join(HOME, '.claude/settings.json'), '{ broken');
    expect(readClaudeSettings({ home: HOME, cwd: CWD })).toEqual({ defaultMode: null, allowRules: [] });
  });

  it('ignores invalid defaultMode values', () => {
    mkdirSync(join(HOME, '.claude'), { recursive: true });
    writeFileSync(join(HOME, '.claude/settings.json'),
      JSON.stringify({ permissions: { defaultMode: 'wat' } }));
    expect(readClaudeSettings({ home: HOME, cwd: CWD }).defaultMode).toBeNull();
  });
});
