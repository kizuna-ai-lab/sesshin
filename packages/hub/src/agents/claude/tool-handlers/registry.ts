import type { ToolHandler } from './types.js';
import { bashHandler } from './bash.js';
import { fileEditHandler } from './file-edit.js';
import { webFetchHandler } from './web-fetch.js';
import { askUserQuestionHandler } from './ask-user-question.js';
import { exitPlanModeHandler } from './exit-plan-mode.js';
import { catchAllHandler } from './catch-all.js';

const MAP: Record<string, ToolHandler> = {
  Bash:                 bashHandler,
  PowerShell:           bashHandler,
  Edit:                 fileEditHandler,
  Write:                fileEditHandler,
  MultiEdit:            fileEditHandler,
  NotebookEdit:         fileEditHandler,
  WebFetch:             webFetchHandler,
  AskUserQuestion:      askUserQuestionHandler,
  ExitPlanMode:         exitPlanModeHandler,
};

export function getHandler(toolName: string): ToolHandler {
  return MAP[toolName] ?? catchAllHandler;
}

export { setCatchAllToolName } from './catch-all.js';
