export interface HooksSettingsInput {
  hookHandlerPath: string;
  sessionId: string;
  hubUrl: string;
  agent: 'claude-code';
}

const EVENTS = ['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','Stop','StopFailure','SessionEnd'] as const;

// claude (>= 2.x) does not honor a per-hook `env` field. Bake the env vars
// into the command string via `/usr/bin/env VAR=value … cmd args` so the
// spawned hook handler sees them in process.env regardless of how claude
// invokes the command.
function buildCommand(o: HooksSettingsInput, evt: string): string {
  const env = [
    `SESSHIN_HUB_URL=${o.hubUrl}`,
    `SESSHIN_SESSION_ID=${o.sessionId}`,
    `SESSHIN_AGENT=${o.agent}`,
  ].join(' ');
  return `/usr/bin/env ${env} ${o.hookHandlerPath} ${evt}`;
}

export function generateHooksOnlySettings(o: HooksSettingsInput): string {
  const hooks: Record<string, unknown> = {};
  for (const evt of EVENTS) {
    hooks[evt] = [{
      matcher: '*',
      hooks: [{
        type: 'command',
        command: buildCommand(o, evt),
      }],
    }];
  }
  // PermissionRequest is an HTTP hook — Claude POSTs the PermissionRequest
  // payload directly to the hub. The session id is encoded in the URL path
  // because Claude's body carries Claude's native session_id (a UUID), not
  // the sesshin-side id the registry knows about.
  hooks['PermissionRequest'] = [{
    hooks: [{
      type: 'http',
      url: `${o.hubUrl}/permission/${o.sessionId}`,
      timeout: 600,
    }],
  }];
  return JSON.stringify({ hooks }, null, 2);
}
