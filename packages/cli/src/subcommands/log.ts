import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

function hubUrl(): string {
  return process.env['SESSHIN_HUB_URL'] ?? 'http://127.0.0.1:9663';
}

interface DiagSession {
  id: string;
  sessionFilePath?: string;
}

export interface LogOpts {
  sessionId?: string;
  tail?: boolean;
  filter?: string;
  json?: boolean;
}

/**
 * Resolve to the JSONL transcript path for a session, then either:
 *   - print just the path (default — composable with $(...))
 *   - tail -F it (--tail)
 *   - stream + filter to lines whose `type` matches --filter
 *
 * `--session` is optional when there's exactly one registered session, or
 * when SESSHIN_SESSION_ID is set in the environment.
 */
export async function runLog(opts: LogOpts): Promise<number> {
  const r = await fetch(`${hubUrl()}/api/v1/diagnostics`);
  if (!r.ok) {
    process.stderr.write(`hub error ${r.status}\n`);
    return 1;
  }
  const j = await r.json() as { sessions: DiagSession[] };
  const desired = opts.sessionId ?? process.env['SESSHIN_SESSION_ID'];
  const candidates = desired
    ? j.sessions.filter((s) => s.id === desired)
    : j.sessions;
  if (candidates.length === 0) {
    process.stderr.write(desired ? `no session matching ${desired}\n` : 'no sessions\n');
    return 2;
  }
  if (candidates.length > 1) {
    process.stderr.write(
      `${candidates.length} sessions; use --session <id> or SESSHIN_SESSION_ID. Available:\n` +
      candidates.map((s) => `  ${s.id}\n`).join(''),
    );
    return 3;
  }
  const path = candidates[0]!.sessionFilePath;
  if (!path) {
    process.stderr.write('session has no transcript path yet (SessionStart hook not fired?)\n');
    return 4;
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify({ sessionId: candidates[0]!.id, path }) + '\n');
    return 0;
  }
  if (opts.tail) {
    // Hand off to `tail -F` so logrotate / atomic-rename handles cleanly.
    const child = spawn('tail', ['-F', path], { stdio: 'inherit' });
    return new Promise((res) => {
      // Handle ENOENT (no `tail` on PATH — minimal containers, Windows w/o
      // GnuWin32) and other spawn errors so we don't hang awaiting exit.
      child.on('error', (err) => {
        process.stderr.write(`failed to spawn tail: ${err.message}\n`);
        res(127);
      });
      child.on('exit', (c) => res(c ?? 0));
    });
  }
  if (opts.filter) {
    return streamFiltered(path, opts.filter);
  }
  // Default: just print the path. Composable: less $(sesshin log) / xclip-i.
  process.stdout.write(path + '\n');
  return 0;
}

async function streamFiltered(path: string, type: string): Promise<number> {
  // createReadStream emits 'error' asynchronously (ENOENT if the file was
  // rotated or deleted between the diagnostics read and now, EACCES on
  // permission failure). readline forwards stream errors as a rejection
  // from the for-await iterator, so a single try/catch covers both the
  // sync construction failures and async stream errors.
  try {
    const stream = createReadStream(path, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      let obj: { type?: unknown };
      try { obj = JSON.parse(line) as { type?: unknown }; }
      catch { continue; }
      if (obj && obj.type === type) process.stdout.write(line + '\n');
    }
    return 0;
  } catch (err) {
    process.stderr.write(`error reading log file ${path}: ${(err as Error).message}\n`);
    return 5;
  }
}
