// packages/hub/src/main.ts
import { log } from './logger.js';
import { startHub } from './wire.js';

async function main(): Promise<void> {
  const hub = await startHub();
  const onSig = (): void => {
    void hub.shutdown().finally(() => process.exit(0));
  };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);
  log.info('sesshin-hub ready');
  await new Promise<void>(() => {});
}
main().catch((e) => { log.fatal({ err: e }, 'fatal'); process.exit(1); });
