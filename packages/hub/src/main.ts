import { log } from './logger.js';
import { config } from './config.js';

async function main(): Promise<void> {
  log.info({ ports: { internal: config.internalPort, public: config.publicPort } }, 'sesshin-hub starting');
  // M3: REST server starts here. M5: WS server starts here.
  // For now keep the process alive so smoke testing works.
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  await new Promise<void>(() => { /* run forever */ });
}
main().catch((e) => {
  log.fatal({ err: e }, 'fatal');
  process.exit(1);
});
