import { isPermissionMode, type PermissionMode } from '@sesshin/shared';

export function parsePermissionModeFlag(args: readonly string[]): PermissionMode | null {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--permission-mode') {
      const v = args[i + 1];
      if (typeof v === 'string' && isPermissionMode(v)) return v;
      return null;
    }
    if (typeof a === 'string' && a.startsWith('--permission-mode=')) {
      const v = a.slice('--permission-mode='.length);
      if (isPermissionMode(v)) return v;
      return null;
    }
  }
  return null;
}
