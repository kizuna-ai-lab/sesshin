import { runClaude } from './claude.js';
import { runStatus } from './subcommands/status.js';
import { runClients } from './subcommands/clients.js';
import { runHistory } from './subcommands/history.js';
import { runCommandsInstall } from './subcommands/commands-install.js';
import { runCommandsUninstall } from './subcommands/commands-uninstall.js';
import { runGate } from './subcommands/gate.js';
import { runPin } from './subcommands/pin.js';
import { runQuiet } from './subcommands/quiet.js';
import { runLog } from './subcommands/log.js';
import { requireLiveSession } from './require-live-session.js';

const SESSION_REQUIRED = new Set(['status', 'clients', 'history', 'gate', 'pin', 'quiet', 'log']);

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
      if (sub === 'install')   return runCommandsInstall();
      if (sub === 'uninstall') return runCommandsUninstall();
      deps.stderr.write('usage: sesshin commands <install|uninstall>\n');
      return 2;
    }
    case 'gate': {
      const sid = pickFlag(rest, '--session') ?? deps.env.SESSHIN_SESSION_ID;
      const positional = stripFlagPair(rest, '--session').filter((a) => !a.startsWith('--'));
      const policy = positional[0];
      if (!sid || !policy) { deps.stderr.write('usage: sesshin gate <disabled|auto|always> [--session <id>]\n'); return 2; }
      return runGate({ sessionId: sid, policy });
    }
    case 'pin': {
      const sid = pickFlag(rest, '--session') ?? deps.env.SESSHIN_SESSION_ID;
      if (!sid) { deps.stderr.write('usage: sesshin pin [<message>] [--session <id>]  (no message clears the pin)\n'); return 2; }
      const positional = stripFlagPair(rest, '--session').filter((a) => !a.startsWith('--'));
      const msg = positional.length > 0 ? positional.join(' ') : null;
      return runPin({ sessionId: sid, message: msg });
    }
    case 'quiet': {
      const sid = pickFlag(rest, '--session') ?? deps.env.SESSHIN_SESSION_ID;
      if (!sid) { deps.stderr.write("usage: sesshin quiet [<duration>|off] [--session <id>]  (e.g. 5m, 30s, 1h)\n"); return 2; }
      const positional = stripFlagPair(rest, '--session').filter((a) => !a.startsWith('--'));
      const dur = positional[0] ?? null;
      return runQuiet({ sessionId: sid, duration: dur });
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
    default:
      deps.stderr.write(`usage: sesshin <claude|status|clients|history|commands|gate|pin|quiet|log> ...\n`);
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

function stripFlagPair(args: readonly string[], name: string): string[] {
  const i = args.indexOf(name);
  return i === -1 ? [...args] : [...args.slice(0, i), ...args.slice(i + 2)];
}
