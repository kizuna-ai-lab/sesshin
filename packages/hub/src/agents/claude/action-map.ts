import type { Action } from '@sesshin/shared';

/**
 * Map a web-driven Action to the raw bytes injected into Claude's PTY.
 * Only TTY-level shortcuts survive here — structured prompt answers go
 * through `prompt-response`, not this path.
 */
export function actionToInput(action: Action): string | null {
  switch (action) {
    case 'approve':  return 'y\r';
    case 'reject':   return 'n\r';
    case 'continue': return '\r';
    case 'stop':     return '\x1b';      // ESC — interrupt
    default:         return null;
  }
}
