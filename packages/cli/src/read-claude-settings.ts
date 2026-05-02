import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { isPermissionMode, type PermissionMode } from '@sesshin/shared';

export interface ClaudeSettings { defaultMode: PermissionMode | null; allowRules: string[] }

function tryRead(path: string): unknown {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

function extractMode(j: unknown): PermissionMode | null {
  const m = (j as { permissions?: { defaultMode?: unknown } } | null)?.permissions?.defaultMode;
  return typeof m === 'string' && isPermissionMode(m) ? m : null;
}

function extractAllow(j: unknown): string[] {
  const a = (j as { permissions?: { allow?: unknown } } | null)?.permissions?.allow;
  return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [];
}

export function readClaudeSettings(opts: { home: string; cwd: string }): ClaudeSettings {
  const userJson    = tryRead(join(opts.home, '.claude/settings.json'));
  const projectJson = tryRead(join(opts.cwd,  '.claude/settings.json'));
  return {
    defaultMode: extractMode(projectJson) ?? extractMode(userJson),
    // User rules first, project rules second — matches Claude's settings layering
    // where project settings refine/append to user settings rather than replace.
    allowRules: [...extractAllow(userJson), ...extractAllow(projectJson)],
  };
}
