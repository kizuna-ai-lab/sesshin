export interface HooksMap { hooks: Record<string, any[]> }

export function mergeUserHooksWithOurs(ours: HooksMap, userSettings: any): HooksMap {
  if (!userSettings || typeof userSettings !== 'object') return ours;
  const userHooks = userSettings.hooks ?? {};
  const out: Record<string, any[]> = { ...(ours.hooks ?? {}) };
  for (const [evt, arr] of Object.entries(userHooks)) {
    if (!Array.isArray(arr)) continue;
    out[evt] = [...arr, ...(out[evt] ?? [])];
  }
  return { hooks: out };
}
