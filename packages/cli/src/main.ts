import { runClaude } from './claude.js';
import { runStatus } from './subcommands/status.js';
import { runClients } from './subcommands/clients.js';
import { runHistory } from './subcommands/history.js';
import { runCommandsInstall } from './subcommands/commands-install.js';
import { runCommandsUninstall } from './subcommands/commands-uninstall.js';
import { runLog } from './subcommands/log.js';
import { runPause } from './subcommands/pause.js';
import { runResume } from './subcommands/resume.js';
import { runKill } from './subcommands/kill.js';
import { runRename } from './subcommands/rename.js';
import { requireLiveSession } from './require-live-session.js';

const SESSION_REQUIRED = new Set(['status', 'clients', 'history', 'log', 'pause', 'resume', 'kill', 'rename']);

/**
 * Resolve the hub base URL from env, matching the convention used by the
 * other subcommands (status/clients/history/log read SESSHIN_HUB_URL directly
 * with the same default). Centralised here so the lifecycle subcommands —
 * which take an injectable `fetch` for testability — can be wired through
 * `mainWithDeps` rather than reading `process.env` themselves.
 */
function hubUrl(env: MainDeps['env']): string {
  return env.SESSHIN_HUB_URL ?? 'http://127.0.0.1:9663';
}

export interface MainDeps {
  argv: string[];
  env: { SESSHIN_SESSION_ID?: string; SESSHIN_HUB_URL?: string };
  fetch: typeof globalThis.fetch;
  stderr: { write: (s: string) => boolean | void };
}

export async function main(): Promise<number | null> {
  return mainWithDeps({
    argv: process.argv.slice(2),
    env: process.env as MainDeps['env'],
    fetch: globalThis.fetch,
    stderr: process.stderr,
  });
}

export async function mainWithDeps(deps: MainDeps): Promise<number | null> {
  const [cmd, ...rest] = deps.argv;

  // Session-context gate: applies to subcommands that require a live session.
  if (cmd && SESSION_REQUIRED.has(cmd)) {
    const explicit = pickFlag(rest, '--session');
    const result = await requireLiveSession({
      env: deps.env,
      ...(explicit !== undefined ? { explicitSessionId: explicit } : {}),
      fetch: deps.fetch,
    });
    if (!result.ok) {
      deps.stderr.write(result.message + '\n');
      return 3;
    }
  }

  try {
    return await dispatch(deps, cmd, rest);
  } catch (e) {
    deps.stderr.write(`fatal: ${(e as { stack?: string })?.stack ?? String(e)}\n`);
    return 1;
  }
}

async function dispatch(deps: MainDeps, cmd: string | undefined, rest: string[]): Promise<number | null> {
  switch (cmd) {
    case 'claude':
      // runClaude returns when claude has been spawned under PTY; the CLI
      // process must keep running until wrap.onExit fires (which calls
      // process.exit). Returning null tells our caller NOT to exit.
      await runClaude(rest);
      return null;
    case 'status': {
      const sid = pickFlag(rest, '--session');
      const json = rest.includes('--json');
      return runStatus({ ...(sid ? { sessionId: sid } : {}), json });
    }
    case 'clients': {
      const sid = pickFlag(rest, '--session');
      const json = rest.includes('--json');
      return runClients({ ...(sid ? { sessionId: sid } : {}), json });
    }
    case 'history': {
      const sid = pickFlag(rest, '--session') ?? deps.env.SESSHIN_SESSION_ID;
      if (!sid) { deps.stderr.write('history: --session required (or SESSHIN_SESSION_ID env)\n'); return 2; }
      const nStr = pickFlag(rest, '-n');
      return runHistory({ sessionId: sid, ...(nStr ? { n: Number(nStr) } : {}), json: rest.includes('--json') });
    }
    case 'commands': {
      const sub = rest[0];
      if (sub === 'install') {
        const pruneOnly = rest.includes('--prune-only');
        return runCommandsInstall({ pruneOnly });
      }
      if (sub === 'uninstall') return runCommandsUninstall();
      deps.stderr.write('usage: sesshin commands <install [--prune-only]|uninstall>\n');
      return 2;
    }
    case 'log': {
      const sid = pickFlag(rest, '--session');
      const filter = pickFlag(rest, '--filter');
      return runLog({
        ...(sid ? { sessionId: sid } : {}),
        tail:   rest.includes('--tail'),
        json:   rest.includes('--json'),
        ...(filter ? { filter } : {}),
      });
    }
    case 'pause': {
      const sid = pickFlag(rest, '--session') ?? deps.env.SESSHIN_SESSION_ID;
      if (!sid) { deps.stderr.write('usage: sesshin pause [--session <id>]\n'); return 2; }
      return runPause({ sessionId: sid, hubUrl: hubUrl(deps.env), fetch: deps.fetch });
    }
    case 'resume': {
      const sid = pickFlag(rest, '--session') ?? deps.env.SESSHIN_SESSION_ID;
      if (!sid) { deps.stderr.write('usage: sesshin resume [--session <id>]\n'); return 2; }
      return runResume({ sessionId: sid, hubUrl: hubUrl(deps.env), fetch: deps.fetch });
    }
    case 'kill': {
      const sid = pickFlag(rest, '--session') ?? deps.env.SESSHIN_SESSION_ID;
      if (!sid) { deps.stderr.write('usage: sesshin kill [--session <id>]\n'); return 2; }
      return runKill({ sessionId: sid, hubUrl: hubUrl(deps.env), fetch: deps.fetch });
    }
    case 'rename': {
      const sid = pickFlag(rest, '--session') ?? deps.env.SESSHIN_SESSION_ID;
      // Positional args = everything that isn't a flag or the value of a flag.
      // We strip `--session <value>` pairs explicitly so the new name can
      // legitimately be multiple words (e.g. `sesshin rename my new name`).
      const positional: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i]!;
        if (a === '--session') { i++; continue; }    // skip flag value
        if (a.startsWith('--')) continue;            // skip other flags
        positional.push(a);
      }
      const name = positional.join(' ').trim();
      if (!sid || !name) { deps.stderr.write('usage: sesshin rename <new name> [--session <id>]\n'); return 2; }
      return runRename({ sessionId: sid, name, hubUrl: hubUrl(deps.env), fetch: deps.fetch });
    }
    default:
      deps.stderr.write(`usage: sesshin <claude|status|clients|history|commands|log|pause|resume|kill|rename> ...\n`);
      return 2;
  }
}

export function pickFlag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined || v === '' || v.startsWith('--')) return undefined;
  return v;
}
