import { runClaude } from './claude.js';
import { runStatus } from './subcommands/status.js';
import { runClients } from './subcommands/clients.js';
import { runHistory } from './subcommands/history.js';
import { runCommandsInstall } from './subcommands/commands-install.js';
import { runCommandsUninstall } from './subcommands/commands-uninstall.js';
import { runTrust } from './subcommands/trust.js';
import { runGate } from './subcommands/gate.js';
import { runPin } from './subcommands/pin.js';
import { runQuiet } from './subcommands/quiet.js';

async function main(): Promise<number | null> {
  const [cmd, ...rest] = process.argv.slice(2);
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
      const sid = pickFlag(rest, '--session') ?? process.env['SESSHIN_SESSION_ID'];
      if (!sid) { process.stderr.write('history: --session required (or SESSHIN_SESSION_ID env)\n'); return 2; }
      const nStr = pickFlag(rest, '-n');
      return runHistory({ sessionId: sid, ...(nStr ? { n: Number(nStr) } : {}), json: rest.includes('--json') });
    }
    case 'commands': {
      const sub = rest[0];
      if (sub === 'install')   return runCommandsInstall();
      if (sub === 'uninstall') return runCommandsUninstall();
      process.stderr.write('usage: sesshin commands <install|uninstall>\n');
      return 2;
    }
    case 'trust': {
      const sid = pickFlag(rest, '--session') ?? process.env['SESSHIN_SESSION_ID'];
      const rule = rest.find((a) => !a.startsWith('--') && a !== sid);
      if (!sid || !rule) { process.stderr.write('usage: sesshin trust <ruleString> [--session <id>]\n'); return 2; }
      return runTrust({ sessionId: sid, ruleString: rule });
    }
    case 'gate': {
      const sid = pickFlag(rest, '--session') ?? process.env['SESSHIN_SESSION_ID'];
      const policy = rest.find((a) => !a.startsWith('--') && a !== sid);
      if (!sid || !policy) { process.stderr.write('usage: sesshin gate <disabled|auto|always> [--session <id>]\n'); return 2; }
      return runGate({ sessionId: sid, policy });
    }
    case 'pin': {
      const sid = pickFlag(rest, '--session') ?? process.env['SESSHIN_SESSION_ID'];
      if (!sid) { process.stderr.write('usage: sesshin pin [<message>] [--session <id>]  (no message clears the pin)\n'); return 2; }
      const positional = rest.filter((a) => !a.startsWith('--') && a !== sid);
      const msg = positional.length > 0 ? positional.join(' ') : null;
      return runPin({ sessionId: sid, message: msg });
    }
    case 'quiet': {
      const sid = pickFlag(rest, '--session') ?? process.env['SESSHIN_SESSION_ID'];
      if (!sid) { process.stderr.write("usage: sesshin quiet [<duration>|off] [--session <id>]  (e.g. 5m, 30s, 1h)\n"); return 2; }
      const positional = rest.filter((a) => !a.startsWith('--') && a !== sid);
      const dur = positional[0] ?? null;
      return runQuiet({ sessionId: sid, duration: dur });
    }
    default:
      process.stderr.write(`usage: sesshin <claude|status|clients|history|commands|trust|gate|pin|quiet> ...\n`);
      return 2;
  }
}

function pickFlag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

main().then((code) => { if (code !== null) process.exit(code); }).catch((e) => {
  process.stderr.write(`fatal: ${e?.stack ?? e}\n`);
  process.exit(1);
});
