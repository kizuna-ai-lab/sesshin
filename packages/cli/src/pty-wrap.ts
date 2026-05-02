import * as pty from 'node-pty';
import type { IPty } from 'node-pty';

export interface PtyWrapInput {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  /** When true, install raw-mode passthrough on the parent's stdin/stdout. */
  passthrough: boolean;
}

export interface PtyWrap {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(fn: (d: string) => void): void;
  onExit(fn: (code: number) => void): void;
  kill(signal?: string): void;
  pid: number;
}

export function wrapPty(opts: PtyWrapInput): PtyWrap {
  const proc: IPty = pty.spawn(opts.command, opts.args, {
    name: 'xterm-256color', cwd: opts.cwd, env: opts.env, cols: opts.cols, rows: opts.rows,
  });

  if (opts.passthrough) installPassthrough(proc);

  const dataListeners = new Set<(d: string) => void>();
  proc.onData((d) => { for (const fn of dataListeners) fn(d); });

  return {
    write: (d) => proc.write(d),
    resize: (cols, rows) => proc.resize(cols, rows),
    onData: (fn) => { dataListeners.add(fn); },
    onExit: (fn) => proc.onExit(({ exitCode }) => fn(exitCode)),
    kill: (sig) => proc.kill(sig),
    get pid() { return proc.pid; },
  };
}

function installPassthrough(proc: IPty): void {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (d) => proc.write(typeof d === 'string' ? d : d.toString('utf-8')));
  proc.onData((d) => process.stdout.write(d));
  const onResize = (): void => proc.resize(process.stdout.columns ?? 80, process.stdout.rows ?? 24);
  process.stdout.on('resize', onResize);
  proc.onExit(() => {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.off('resize', onResize);
  });
}
