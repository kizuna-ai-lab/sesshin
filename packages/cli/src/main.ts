import { runClaude } from './claude.js';

async function main(): Promise<void> {
  const sub = process.argv[2];
  if (sub === 'claude') return await runClaude(process.argv.slice(3));
  process.stderr.write(`Usage: sesshin claude [-- claude-args...]\n`);
  process.exit(2);
}
main().catch((e) => { process.stderr.write(`fatal: ${e?.stack ?? e}\n`); process.exit(1); });
