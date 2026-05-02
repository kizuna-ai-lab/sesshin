import { join } from 'node:path';

/**
 * Encoding rule for ~/.claude/projects/<encoded>/ directories.
 * Confirmed empirically in validation gate 2 (docs/validation-log.md §12.2):
 * BOTH `/` and `.` are replaced with `-`. The encoding is non-injective; do
 * not attempt to reverse it.
 */
export function encodeCwdForClaudeProjects(cwd: string): string {
  return cwd.replaceAll('/', '-').replaceAll('.', '-');
}

export function sessionFilePath(o: { home: string; cwd: string; sessionId: string }): string {
  return join(o.home, '.claude', 'projects', encodeCwdForClaudeProjects(o.cwd), `${o.sessionId}.jsonl`);
}
