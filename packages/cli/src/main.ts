import { runClaude } from './claude.js';
import { runStatus } from './subcommands/status.js';
import { runClients } from './subcommands/clients.js';
import { runHistory } from './subcommands/history.js';

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
    default:
      process.stderr.write(`usage: sesshin <claude|status|clients|history> ...\n`);
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
