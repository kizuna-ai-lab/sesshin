import { useRef } from 'preact/hooks';
import type { WsClient } from '../ws-client.js';

export interface TextInputProps {
  ws: WsClient;
  sessionId: string;
  /** Hard disable — grays out and blocks send. Reserved for future
   * "session-not-yet-ready" / "session-gone" cases. NOT used for pause
   * (in nested-shell architecture, pause means the inner shell is live
   * and accepts input — disabling here would be needlessly restrictive). */
  disabled?: boolean;
  /** True when the inner shell currently holds PTY foreground (claude is
   * suspended). Only swaps the placeholder so users know typing now goes
   * to the shell, not to claude. The textarea stays active. */
  paused?: boolean;
}

export function TextInput({ ws, sessionId, disabled = false, paused = false }: TextInputProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const placeholder = disabled
    ? 'session unavailable'
    : paused
      ? 'shell command (claude paused)…'
      : 'message claude…';
  return (
    <div style={{ marginBottom: 12 }}>
      <textarea ref={inputRef} placeholder={placeholder} rows={3}
        disabled={disabled}
        style={{
          width: '100%',
          background: disabled ? '#0a0a0a' : '#111',
          color: disabled ? '#666' : '#eee',
          border: '1px solid #444',
          padding: 6,
          cursor: disabled ? 'not-allowed' : 'text',
        }} />
      <button data-testid="send-text"
        disabled={disabled}
        onClick={() => { const v = inputRef.current?.value ?? ''; if (v.trim()) { ws.sendText(sessionId, v + '\r'); if (inputRef.current) inputRef.current.value = ''; } }}
        style={{
          padding: '4px 12px',
          background: disabled ? '#1a2a3a' : '#246',
          color: disabled ? '#88a' : '#fff',
          border: 0,
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}>Send</button>
    </div>
  );
}
