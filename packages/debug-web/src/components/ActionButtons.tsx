import type { WsClient } from '../ws-client.js';

/**
 * Single Stop (ESC) button. The only TTY shortcut left after cleanup —
 * everything else (y/n, Enter, structured prompt answers) is reachable
 * via TextInput or the InteractionPanel.
 */
export function ActionButtons({ ws, sessionId }: { ws: WsClient; sessionId: string }) {
  return (
    <div style={{ marginBottom: 12 }} data-testid="action-buttons">
      <button
        type="button"
        onClick={() => ws.sendAction(sessionId, 'stop')}
        title="Send ESC — interrupt running tool"
        style={{
          padding: '4px 12px',
          background: '#3a1a1a', color: '#fdd', border: '1px solid #844',
          borderRadius: 3, cursor: 'pointer',
        }}
      >
        Stop (ESC)
      </button>
    </div>
  );
}
