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
    '/etc/claude/settings.json',                                  // enterprise
    join(opts.cwd,  '.claude/settings.local.json'),               // project (local)
    join(opts.cwd,  '.claude/settings.json'),                     // project
    join(opts.home, '.claude/settings.json'),                     // user
  ];
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
