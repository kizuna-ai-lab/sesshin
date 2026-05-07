import { readFileSync } from 'node:fs';

export type ProcState = 'running' | 'stopped' | 'dead' | 'gone' | 'unknown';

/** Exposed for testing. Returns the State letter (R/S/D/T/Z/X) or null. */
export function parseStat(raw: string): string | null {
  if (!raw) return null;
  const lastParen = raw.lastIndexOf(')');
  if (lastParen < 0) return null;
  const after = raw.slice(lastParen + 2);
  const fields = after.split(/\s+/);
  if (fields.length < 1) return null;
  const letter = fields[0];
  if (!letter || letter.length !== 1) return null;
  return letter;
}

/**
 * Read /proc/<pid>/status (via /proc/<pid>/stat for compactness) and map the
 * State letter to a coarse enum. Linux-only; returns 'unknown' otherwise.
 */
export function readProcState(pid: number): ProcState {
  if (process.platform !== 'linux') return 'unknown';
  if (!Number.isFinite(pid) || pid <= 0) return 'gone';
  let raw: string;
  try {
    raw = readFileSync(`/proc/${pid}/stat`, 'utf-8');
  } catch {
    return 'gone';
  }
  const letter = parseStat(raw);
  switch (letter) {
    case 'R': case 'S': case 'D': return 'running';
    case 'T': case 't':            return 'stopped';
    case 'Z': case 'X':            return 'dead';
    default:                        return 'unknown';
  }
}
