import type { WsClient } from '../ws-client.js';

export interface PauseControlsProps {
  ws: WsClient;
  sessionId: string;
  paused: boolean;
}

/**
 * Banner + Pause/Resume buttons.
 *
 * In the nested-shell architecture, "pause" and "resume" are just bytes
 * delivered into the PTY:
 *   - Pause  → \x1a (Ctrl+Z)            : the PTY's ISIG sends SIGTSTP to
 *                                          the foreground job (claude). The
 *                                          inner shell takes back foreground
 *                                          and prints its prompt.
 *   - Resume → 'fg\r'                   : inner shell's `fg` builtin SIGCONTs
 *                                          the suspended job.
 *
 * The `paused` flag is broadcast from hub.substate.paused, which the cli's
 * pause-monitor sets via /proc/<shellPid>/stat tpgid polling.
 */
export function PauseControls({ ws, sessionId, paused }: PauseControlsProps) {
  const onPause = (): void => { ws.sendText(sessionId, '\x1a'); };
  const onResume = (): void => { ws.sendText(sessionId, 'fg\r'); };

  return (
    <div data-testid="pause-controls" style={{ marginBottom: 12 }}>
      {paused && (
        <div data-testid="pause-banner" style={{
          padding: '6px 10px', marginBottom: 8,
          background: '#3a2a0e', color: '#f0c674',
          border: '1px solid #b58900', borderRadius: 3,
          fontFamily: 'monospace', fontSize: 12,
        }}>
          Session paused — claude is suspended in the inner shell. Click Resume,
          or run <code>fg</code> in the host terminal.
        </div>
      )}
      <button
        type="button"
        data-testid={paused ? 'resume-btn' : 'pause-btn'}
        onClick={paused ? onResume : onPause}
        style={{
          padding: '4px 12px',
          background: paused ? '#1a3a1a' : '#3a1a1a',
          color: paused ? '#dfd' : '#fdd',
          border: `1px solid ${paused ? '#484' : '#844'}`,
          borderRadius: 3,
          cursor: 'pointer',
        }}
      >
        {paused ? 'Resume' : 'Pause'}
      </button>
    </div>
  );
}
