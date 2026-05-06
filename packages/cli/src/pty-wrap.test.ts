import { describe, it, expect } from 'vitest';
import { wrapPty } from './pty-wrap.js';

describe('wrapPty', () => {
  it('captures stdout from a child process', async () => {
    const out: string[] = [];
    const wrapper = wrapPty({
      command: '/bin/sh',
      args: ['-c', 'echo hello-pty; sleep 0.05'],
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      cols: 80, rows: 24,
    });
    wrapper.onData((d) => out.push(d));
    const exit = await new Promise<number>((r) => wrapper.onExit((c) => r(c)));
    expect(exit).toBe(0);
    expect(out.join('')).toContain('hello-pty');
  });
  it('forwards write() to the child stdin', async () => {
    const out: string[] = [];
    const wrapper = wrapPty({
      command: '/bin/sh',
      args: ['-c', "read line; echo got:$line"],
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      cols: 80, rows: 24,
    });
    wrapper.onData((d) => out.push(d));
    wrapper.write('hi\n');
    const exit = await new Promise<number>((r) => wrapper.onExit((c) => r(c)));
    expect(exit).toBe(0);
    expect(out.join('')).toContain('got:hi');
  });
});
