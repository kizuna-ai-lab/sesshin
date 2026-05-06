import { useRef } from 'preact/hooks';
import type { WsClient } from '../ws-client.js';

export interface TextInputProps {
  ws: WsClient;
  sessionId: string;
  /** When true (session.substate.paused), gray out the textarea + button so
   * we don't accidentally type into the inner shell while claude is suspended. */
  disabled?: boolean;
}

export function TextInput({ ws, sessionId, disabled = false }: TextInputProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  return (
    <div style={{ marginBottom: 12 }}>
      <textarea ref={inputRef} placeholder={disabled ? 'session paused' : 'message claude…'} rows={3}
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
