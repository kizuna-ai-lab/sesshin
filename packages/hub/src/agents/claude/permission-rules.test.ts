import { describe, it, expect } from 'vitest';
import { parseRuleString, formatRuleString, matchRule, ruleMatchesAny } from './permission-rules.js';

describe('parseRuleString', () => {
  it('parses bare tool name', () => {
    expect(parseRuleString('Bash')).toEqual({ toolName: 'Bash', ruleContent: null });
  });
  it('parses Tool(content)', () => {
    expect(parseRuleString('Bash(npm install)')).toEqual({ toolName: 'Bash', ruleContent: 'npm install' });
  });
  it('parses with prefix wildcard', () => {
    expect(parseRuleString('Bash(git log:*)')).toEqual({ toolName: 'Bash', ruleContent: 'git log:*' });
  });
  it('handles escaped parens in content', () => {
    expect(parseRuleString('Bash(python -c "print\\(1\\)")')).toEqual({
      toolName: 'Bash', ruleContent: 'python -c "print(1)"',
    });
  });
  it('returns null for malformed', () => {
    expect(parseRuleString('garbage(')).toBeNull();
  });
});

describe('formatRuleString', () => {
  it('formats with escaping', () => {
    expect(formatRuleString('Bash', 'python -c "print(1)"'))
      .toBe('Bash(python -c "print\\(1\\)")');
  });
  it('formats null content as bare name', () => {
    expect(formatRuleString('Bash', null)).toBe('Bash');
  });
});

describe('matchRule — Bash', () => {
  it('bare Bash matches all calls', () => {
    expect(matchRule('Bash', { command: 'rm -rf /' }, parseRuleString('Bash')!)).toBe(true);
  });
  it('exact match', () => {
    expect(matchRule('Bash', { command: 'npm install' }, parseRuleString('Bash(npm install)')!)).toBe(true);
    expect(matchRule('Bash', { command: 'npm uninstall' }, parseRuleString('Bash(npm install)')!)).toBe(false);
  });
  it('prefix wildcard', () => {
    const rule = parseRuleString('Bash(git log:*)')!;
    expect(matchRule('Bash', { command: 'git log --oneline' }, rule)).toBe(true);
    expect(matchRule('Bash', { command: 'git logout' }, rule)).toBe(false);
  });
});

describe('matchRule — file tools', () => {
  it('Edit dir glob', () => {
    const rule = parseRuleString('Edit(/proj/src/*)')!;
    expect(matchRule('Edit', { file_path: '/proj/src/a.ts' }, rule)).toBe(true);
    expect(matchRule('Edit', { file_path: '/proj/src/sub/b.ts' }, rule)).toBe(true);
    expect(matchRule('Edit', { file_path: '/proj/test.ts' }, rule)).toBe(false);
  });
  it('Write exact file match', () => {
    const rule = parseRuleString('Write(/etc/hosts)')!;
    expect(matchRule('Write', { file_path: '/etc/hosts' }, rule)).toBe(true);
    expect(matchRule('Write', { file_path: '/etc/passwd' }, rule)).toBe(false);
  });
});

describe('matchRule — WebFetch', () => {
  it('host glob', () => {
    const rule = parseRuleString('WebFetch(https://example.com/*)')!;
    expect(matchRule('WebFetch', { url: 'https://example.com/api' }, rule)).toBe(true);
    expect(matchRule('WebFetch', { url: 'https://other.com/api' }, rule)).toBe(false);
  });
});

describe('ruleMatchesAny', () => {
  it('returns true on first matching rule', () => {
    expect(ruleMatchesAny('Bash', { command: 'git log' }, [
      'Bash(npm install)',
      'Bash(git log:*)',
      'Bash(rm -rf:*)',
    ])).toBe(true);
  });
  it('returns false when no rules match', () => {
    expect(ruleMatchesAny('Bash', { command: 'git log' }, [
      'Bash(npm install)',
      'Edit(/tmp/*)',
    ])).toBe(false);
  });
  it('skips malformed rules', () => {
    expect(ruleMatchesAny('Bash', { command: 'git log' }, [
      'garbage(',
      'Bash(git log:*)',
    ])).toBe(true);
  });
});
