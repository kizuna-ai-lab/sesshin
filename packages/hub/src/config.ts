import { homedir } from 'node:os';
import { join } from 'node:path';

export const config = {
  /** Loopback REST port for CLI + hook-handler ingress. */
  internalPort: Number(process.env['SESSHIN_INTERNAL_PORT'] ?? 9663),
  /** Public WS+HTTP port for adapters/browsers. */
  publicPort:   Number(process.env['SESSHIN_PUBLIC_PORT']   ?? 9662),
  /** Bind addresses for the two servers (v1: localhost only). */
  internalHost: '127.0.0.1',
  publicHost:   '127.0.0.1',
  /** Persistent state location. */
  cacheDir:     join(homedir(), '.cache', 'sesshin'),
  hubLogFile:   join(homedir(), '.cache', 'sesshin', 'hub.log'),
  /** Grace period after last session unregisters. */
  autoShutdownMs: 30_000,
  /** PTY raw stream ring buffer (bytes). */
  rawRingBytes: 256 * 1024,
};
