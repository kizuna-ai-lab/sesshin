import { spawn } from 'node:child_process';

export interface EnsureHubInput {
  hubBin: string;
  hubArgs?: string[];
  port: number;
  healthTimeoutMs: number;
}

export async function ensureHubRunning(opts: EnsureHubInput): Promise<{ spawned: boolean }> {
  if (await healthOk(opts.port, 500)) return { spawned: false };
  const child = spawn(opts.hubBin, opts.hubArgs ?? [], { detached: true, stdio: 'ignore' });
  child.unref();
  const ok = await waitForHealth(opts.port, opts.healthTimeoutMs);
  if (!ok) throw new Error(`hub failed to come up within ${opts.healthTimeoutMs}ms`);
  return { spawned: true };
}

async function healthOk(port: number, timeoutMs: number): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: ctrl.signal });
    return r.ok;
  } catch { return false; }
  finally { clearTimeout(t); }
}

async function waitForHealth(port: number, totalMs: number): Promise<boolean> {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    if (await healthOk(port, 200)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
