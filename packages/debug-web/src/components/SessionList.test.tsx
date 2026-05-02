import { describe, it, expect } from 'vitest';
import { render } from 'preact';
import { SessionList } from './SessionList.js';
import { sessions, selectedSessionId } from '../store.js';

describe('SessionList', () => {
  it('renders one row per session', () => {
    const div = document.createElement('div');
    sessions.value = [
      { id: 's1', name: 'a', agent: 'claude-code', cwd: '/a', pid: 1, startedAt: 0, state: 'idle', substate: { currentTool: null, lastTool: null, lastFileTouched: null, lastCommandRun: null, elapsedSinceProgressMs: 0, tokensUsedTurn: null, connectivity: 'ok', stalled: false }, lastSummaryId: null },
      { id: 's2', name: 'b', agent: 'claude-code', cwd: '/b', pid: 2, startedAt: 0, state: 'running', substate: { currentTool: 'Edit', lastTool: null, lastFileTouched: null, lastCommandRun: null, elapsedSinceProgressMs: 0, tokensUsedTurn: null, connectivity: 'ok', stalled: false }, lastSummaryId: null },
    ];
    render(<SessionList />, div);
    const rows = div.querySelectorAll('[data-testid="session-row"]');
    expect(rows.length).toBe(2);
  });
  it('clicking a row updates selectedSessionId', () => {
    const div = document.createElement('div');
    sessions.value = [
      { id: 's1', name: 'a', agent: 'claude-code', cwd: '/a', pid: 1, startedAt: 0, state: 'idle', substate: { currentTool: null, lastTool: null, lastFileTouched: null, lastCommandRun: null, elapsedSinceProgressMs: 0, tokensUsedTurn: null, connectivity: 'ok', stalled: false }, lastSummaryId: null },
    ];
    render(<SessionList />, div);
    (div.querySelector('[data-testid="session-row"]') as HTMLElement).click();
    expect(selectedSessionId.value).toBe('s1');
  });
});
