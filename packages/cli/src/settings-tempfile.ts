export interface HooksSettingsInput {
  hookHandlerPath: string;
  sessionId: string;
  hubUrl: string;
  agent: 'claude-code';
}

const EVENTS = ['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','Stop','StopFailure','SessionEnd'] as const;

export function generateHooksOnlySettings(o: HooksSettingsInput): string {
  const env = {
    SESSHIN_HUB_URL:    o.hubUrl,
    SESSHIN_SESSION_ID: o.sessionId,
    SESSHIN_AGENT:      o.agent,
  };
  const hooks: Record<string, unknown> = {};
  for (const evt of EVENTS) {
    hooks[evt] = [{
      matcher: '*',
      hooks: [{
        type: 'command',
        command: `${o.hookHandlerPath} ${evt}`,
        env,
      }],
    }];
  }
  return JSON.stringify({ hooks }, null, 2);
}
