import { PermissionModeEnum, type PermissionMode } from '@sesshin/shared';

const VALID = new Set<PermissionMode>(PermissionModeEnum.options);

export function parsePermissionModeFlag(args: readonly string[]): PermissionMode | null {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--permission-mode') {
      const v = args[i + 1];
      if (typeof v === 'string' && VALID.has(v as PermissionMode)) return v as PermissionMode;
      return null;
    }
    if (typeof a === 'string' && a.startsWith('--permission-mode=')) {
      const v = a.slice('--permission-mode='.length);
      if (VALID.has(v as PermissionMode)) return v as PermissionMode;
      return null;
    }
  }
  return null;
}
