import { describe, it, expect } from 'vitest';
import { detectParentShell } from './detect-shell.js';

describe('detectParentShell', () => {
  it('always returns a recognized shell, even when run under non-shell parents (vitest)', () => {
    // The vitest runner has `node` as parent. detectParentShell must REJECT
    // node and fall back to env.SHELL or /bin/sh — otherwise we'd write the
    // claude command into a JS REPL.
    const r = detectParentShell();
    const known = ['bash', 'zsh', 'fish', 'dash', 'sh', 'ksh', 'mksh', 'tcsh', 'csh', 'busybox'];
    expect(known).toContain(r.name);
    expect(r.bin.length).toBeGreaterThan(0);
  });
  it('returns absolute path or env-derived path for bin', () => {
    const r = detectParentShell();
    expect(r.bin === '/bin/sh' || r.bin.startsWith('/') || r.bin === process.env['SHELL']).toBe(true);
  });
});
