import pino from 'pino';
import { config } from './config.js';
import { mkdirSync, createWriteStream } from 'node:fs';
import { dirname } from 'node:path';

mkdirSync(dirname(config.hubLogFile), { recursive: true });
const dest = createWriteStream(config.hubLogFile, { flags: 'a' });

export const log = pino({ level: process.env['SESSHIN_LOG_LEVEL'] ?? 'info' }, dest);
