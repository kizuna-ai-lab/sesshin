import { readFileSync } from 'node:fs';

export interface SessionLivenessResult {
  pidExists: boolean;
  pidMatchesSesshinProcess: boolean;
  lastHeartbeatAgeMs: number;
  heartbeatExpired: boolean;
  shouldKeep: boolean;
  reason: 'healthy' | 'pid-missing' | 'pid-mismatch' | 'heartbeat-expired';
}

export interface EvaluateSessionLivenessOptions {
  pid: number;
  lastHeartbeat: number;
  heartbeatTimeoutMs: number;
  pidExists?: (pid: number) => boolean;
  pidMatchesSesshinProcess?: (pid: number) => boolean;
  now?: () => number;
}

export function evaluateSessionLiveness(opts: EvaluateSessionLivenessOptions): SessionLivenessResult {
  const now = opts.now ?? Date.now;
  const lastHeartbeatAgeMs = Math.max(0, now() - opts.lastHeartbeat);
  const heartbeatExpired = lastHeartbeatAgeMs > opts.heartbeatTimeoutMs;
  const pidExists = (opts.pidExists ?? defaultPidExists)(opts.pid);
  const pidMatchesSesshinProcess = pidExists && (opts.pidMatchesSesshinProcess ?? defaultPidMatchesSesshinProcess)(opts.pid);

  if (!pidExists) {
    return {
      pidExists,
      pidMatchesSesshinProcess: false,
      lastHeartbeatAgeMs,
      heartbeatExpired,
      shouldKeep: false,
      reason: 'pid-missing',
    };
  }

  if (!pidMatchesSesshinProcess) {
    return {
      pidExists,
      pidMatchesSesshinProcess,
      lastHeartbeatAgeMs,
      heartbeatExpired: false,
      shouldKeep: false,
      reason: 'pid-mismatch',
    };
  }

  if (heartbeatExpired) {
    return {
      pidExists,
      pidMatchesSesshinProcess,
      lastHeartbeatAgeMs,
      heartbeatExpired,
      shouldKeep: false,
      reason: 'heartbeat-expired',
    };
  }

  return {
    pidExists,
    pidMatchesSesshinProcess,
    lastHeartbeatAgeMs,
    heartbeatExpired,
    shouldKeep: true,
    reason: 'healthy',
  };
}

function defaultPidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultPidMatchesSesshinProcess(pid: number): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const cmdline = readProc(`/proc/${pid}/cmdline`);
    if (!cmdline) return false;
    return cmdline.includes('sesshin') || cmdline.includes('claude');
  } catch {
    return false;
  }
}

function readProc(path: string): string {
  return readFileSync(path, 'utf8').replace(/\0/g, ' ').trim();
}
