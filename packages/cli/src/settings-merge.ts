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

export interface MergeSettingsParams {
  /** The base settings object (e.g. from generateHooksOnlySettings, already parsed). */
  base: Record<string, any>;
  /** Absolute path to the sesshin-statusline-relay binary. */
  relayBinPath: string;
  /** Environment variable map — typically process.env. */
  env: Record<string, string | undefined>;
}

/**
 * Merges base settings with sesshin additions (statusLine injection).
 * Opt-out: set SESSHIN_DISABLE_STATUSLINE_RELAY=1 in env to skip injection.
 */
export function mergeSettings(params: MergeSettingsParams): Record<string, any> {
  const merged: Record<string, any> = { ...params.base };
  if (params.env['SESSHIN_DISABLE_STATUSLINE_RELAY'] !== '1') {
    merged['statusLine'] = { type: 'command', command: params.relayBinPath };
  }
  return merged;
}
