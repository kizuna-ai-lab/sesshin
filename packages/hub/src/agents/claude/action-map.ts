import type { Action } from '@sesshin/shared';

export function actionToInput(action: Action): string | null {
  switch (action) {
    case 'approve':   return 'y\n';
    case 'reject':    return 'n\n';
    case 'continue':  return '\n';
    case 'stop':      return '\x1b';      // ESC
    case 'retry':     return '/retry\n';
    case 'fix':       return '/fix\n';
    case 'summarize': return '/summarize\n';
    case 'details':   return '/details\n';
    case 'ignore':    return '';
    case 'snooze':    return '';
    default:          return null;
  }
}
