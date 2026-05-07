import type { WsClient } from '../ws-client.js';

/** ANSI escape sent for Shift+Tab — the same byte sequence cc receives from
 *  the user's keyboard, which triggers `cyclePermissionMode`. Sending it via
 *  WS → hub → cli → PTY is indistinguishable from a real keystroke from cc's
 *  perspective. */
const SHIFT_TAB = '\x1b[Z';

interface Props {
  ws:        WsClient;
  sessionId: string;
  /** True when cc is suspended in the wrapping shell (Ctrl+Z'd) — keystrokes
   *  routed through the cli wouldn't reach cc, so disable. */
  disabled?: boolean;
}

/**
 * Sends Shift+Tab to the cc TUI to advance through the permission-mode
 * cycle (default → acceptEdits → plan → [bypass?] → [auto?] → default,
 * with optional rungs depending on flags / settings — see
 * cc/src/utils/permissions/getNextPermissionMode.ts). One click = one
 * advance; users keep clicking until the ModeBadge shows the desired mode,
 * matching how the keystroke works in cc itself.
 */
export function CycleModeButton({ ws, sessionId, disabled }: Props) {
  return (
    <button
      type="button"
      data-testid="cycle-mode-button"
      onClick={() => ws.sendText(sessionId, SHIFT_TAB)}
      disabled={disabled}
      title="Send Shift+Tab — cycle cc permission mode (default → acceptEdits → plan → ...)"
      style={{
        fontSize: 11,
        padding: '2px 8px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        border: '1px solid #444',
        borderRadius: 3,
        background: '#1a2a1a',
        color: disabled ? '#666' : '#bdf5b9',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      ⇆ Cycle (Shift+Tab)
    </button>
  );
}
