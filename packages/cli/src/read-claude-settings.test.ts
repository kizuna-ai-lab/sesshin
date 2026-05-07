import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClaudeSettings, resolveInheritedStatusLine } from './read-claude-settings.js';

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
    expect(readClaudeSettings({ home: HOME, cwd: CWD })).toEqual({ defaultMode: null });
  });

  it('reads user defaultMode from ~/.claude/settings.json', () => {
    mkdirSync(join(HOME, '.claude'), { recursive: true });
    writeFileSync(join(HOME, '.claude/settings.json'),
      JSON.stringify({ permissions: { defaultMode: 'auto' } }));
    expect(readClaudeSettings({ home: HOME, cwd: CWD })).toEqual({ defaultMode: 'auto' });
  });

  it('project settings override user defaultMode', () => {
    mkdirSync(join(HOME, '.claude'), { recursive: true });
    writeFileSync(join(HOME, '.claude/settings.json'),
      JSON.stringify({ permissions: { defaultMode: 'auto' } }));
    mkdirSync(join(CWD, '.claude'), { recursive: true });
    writeFileSync(join(CWD, '.claude/settings.json'),
      JSON.stringify({ permissions: { defaultMode: 'default' } }));
    expect(readClaudeSettings({ home: HOME, cwd: CWD })).toEqual({ defaultMode: 'default' });
  });

  it('tolerates malformed JSON', () => {
    mkdirSync(join(HOME, '.claude'), { recursive: true });
    writeFileSync(join(HOME, '.claude/settings.json'), '{ broken');
    expect(readClaudeSettings({ home: HOME, cwd: CWD })).toEqual({ defaultMode: null });
  });

  it('ignores invalid defaultMode values', () => {
    mkdirSync(join(HOME, '.claude'), { recursive: true });
    writeFileSync(join(HOME, '.claude/settings.json'),
      JSON.stringify({ permissions: { defaultMode: 'wat' } }));
    expect(readClaudeSettings({ home: HOME, cwd: CWD }).defaultMode).toBeNull();
  });
});

describe('resolveInheritedStatusLine', () => {
  it('returns null when no settings file has a statusLine', () => {
    expect(resolveInheritedStatusLine({ home: HOME, cwd: CWD })).toBeNull();
  });

  it('returns user-level statusLine when only ~/.claude/settings.json has one', () => {
    mkdirSync(join(HOME, '.claude'), { recursive: true });
    writeFileSync(join(HOME, '.claude/settings.json'), JSON.stringify({
      statusLine: { type: 'command', command: 'my-statusline' },
    }));
    expect(resolveInheritedStatusLine({ home: HOME, cwd: CWD }))
      .toEqual({ command: 'my-statusline' });
  });

  it('project-level statusLine wins over user-level', () => {
    mkdirSync(join(HOME, '.claude'), { recursive: true });
    mkdirSync(join(CWD, '.claude'), { recursive: true });
    writeFileSync(join(HOME, '.claude/settings.json'), JSON.stringify({
      statusLine: { type: 'command', command: 'user-cmd' },
    }));
    writeFileSync(join(CWD, '.claude/settings.json'), JSON.stringify({
      statusLine: { type: 'command', command: 'project-cmd', padding: 1 },
    }));
    expect(resolveInheritedStatusLine({ home: HOME, cwd: CWD }))
      .toEqual({ command: 'project-cmd', padding: 1 });
  });

  it('skips the excluded settings path even if it has a statusLine', () => {
    mkdirSync(join(HOME, '.claude'), { recursive: true });
    const tmpInjected = join(CWD, 'sesshin-injected.json');
    writeFileSync(tmpInjected, JSON.stringify({
      statusLine: { type: 'command', command: 'sesshin-relay' },
    }));
    writeFileSync(join(HOME, '.claude/settings.json'), JSON.stringify({
      statusLine: { type: 'command', command: 'user-cmd' },
    }));
    expect(resolveInheritedStatusLine({ home: HOME, cwd: CWD, excludePath: tmpInjected }))
      .toEqual({ command: 'user-cmd' });
  });

  it('ignores statusLine entries whose type is not "command"', () => {
    mkdirSync(join(HOME, '.claude'), { recursive: true });
    writeFileSync(join(HOME, '.claude/settings.json'), JSON.stringify({
      statusLine: { type: 'static', value: 'hi' } as unknown,
    }));
    expect(resolveInheritedStatusLine({ home: HOME, cwd: CWD })).toBeNull();
  });
});
