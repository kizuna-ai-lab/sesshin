import type { Action } from '@sesshin/shared';

export function actionToInput(action: Action): string | null {
  switch (action) {
    case 'approve':   return 'y\r';
    case 'reject':    return 'n\r';
    case 'continue':  return '\r';
    case 'stop':      return '\x1b';      // ESC
    case 'retry':     return '/retry\r';
    case 'fix':       return '/fix\r';
    case 'summarize': return '/summarize\r';
    case 'details':   return '/details\r';
    case 'ignore':    return '';
    case 'snooze':    return '';
    default:          return null;
  }
}
