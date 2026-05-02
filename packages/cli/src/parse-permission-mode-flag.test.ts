import { describe, it, expect } from 'vitest';
import { parsePermissionModeFlag } from './parse-permission-mode-flag.js';

describe('parsePermissionModeFlag', () => {
  it('returns null when flag not present', () => {
    expect(parsePermissionModeFlag(['hello'])).toBeNull();
  });
  it('parses --permission-mode <value>', () => {
    expect(parsePermissionModeFlag(['--permission-mode', 'auto'])).toBe('auto');
  });
  it('parses --permission-mode=value', () => {
    expect(parsePermissionModeFlag(['--permission-mode=acceptEdits'])).toBe('acceptEdits');
  });
  it('returns null for unknown values', () => {
    expect(parsePermissionModeFlag(['--permission-mode', 'bogus'])).toBeNull();
  });
});
