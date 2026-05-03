import type { Action } from '@sesshin/shared';

/**
 * Map a web-driven Action to the raw bytes injected into Claude's PTY.
 * Only `stop` (ESC) remains — y/n/Enter are typeable via TextInput, and
 * structured prompt answers go through `prompt-response`.
 */
export function actionToInput(action: Action): string | null {
  switch (action) {
    case 'stop':     return '\x1b';      // ESC — interrupt
    default:         return null;
  }
}
