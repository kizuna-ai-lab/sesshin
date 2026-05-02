import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PermissionModeEnum, type PermissionMode } from '@sesshin/shared';

const VALID_MODES = new Set<PermissionMode>(PermissionModeEnum.options);

export interface ClaudeSettings { defaultMode: PermissionMode | null; allowRules: string[] }

function tryRead(path: string): unknown {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

function extractMode(j: unknown): PermissionMode | null {
  const m = (j as { permissions?: { defaultMode?: unknown } } | null)?.permissions?.defaultMode;
  return typeof m === 'string' && VALID_MODES.has(m as PermissionMode) ? (m as PermissionMode) : null;
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
    allowRules: [...extractAllow(userJson), ...extractAllow(projectJson)],
  };
}
