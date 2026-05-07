import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { isPermissionMode, type PermissionMode } from '@sesshin/shared';

export interface ClaudeSettings { defaultMode: PermissionMode | null }

function tryRead(path: string): unknown {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

function extractMode(j: unknown): PermissionMode | null {
  const m = (j as { permissions?: { defaultMode?: unknown } } | null)?.permissions?.defaultMode;
  return typeof m === 'string' && isPermissionMode(m) ? m : null;
}

export function readClaudeSettings(opts: { home: string; cwd: string }): ClaudeSettings {
  const userJson    = tryRead(join(opts.home, '.claude/settings.json'));
  const projectJson = tryRead(join(opts.cwd,  '.claude/settings.json'));
  return {
    defaultMode: extractMode(projectJson) ?? extractMode(userJson),
  };
}

export interface ResolveStatusLineOpts {
  home: string;
  cwd: string;
  /** Absolute path of a settings file to skip in the inheritance walk
   *  (used to omit our own injected --settings temp file). */
  excludePath?: string;
}

export interface InheritedStatusLine {
  command: string;
  padding?: number;
}

export function resolveInheritedStatusLine(opts: ResolveStatusLineOpts): InheritedStatusLine | null {
  const candidates: string[] = [
    join(opts.cwd,  '.claude/settings.local.json'),               // project (local)
    join(opts.cwd,  '.claude/settings.json'),                     // project
    join(opts.home, '.claude/settings.json'),                     // user
  ];
  // User-level statusLine inheritance only (project + user); enterprise managed-settings
  // resolution is intentionally out of scope for v1 and would require platform-specific
  // paths (macOS: /Library/Application Support/ClaudeCode/managed-settings.json, Linux:
  // /etc/claude-code/managed-settings.json).
  // Highest precedence first per CC's resolution order.
  for (const path of candidates) {
    if (opts.excludePath && path === opts.excludePath) continue;
    const sl = readStatusLineFromFile(path);
    if (sl) return sl;
  }
  return null;
}

function readStatusLineFromFile(path: string): InheritedStatusLine | null {
  let raw: string;
  try { raw = readFileSync(path, 'utf-8'); } catch { return null; }
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return null; }
  const sl = parsed?.statusLine;
  if (!sl || sl.type !== 'command' || typeof sl.command !== 'string') return null;
  const out: InheritedStatusLine = { command: sl.command };
  if (typeof sl.padding === 'number') out.padding = sl.padding;
  return out;
}
