import { useState } from 'preact/hooks';

interface Props {
  /** The text that will be written to the clipboard. */
  text: string;
  /** Default button label (replaced briefly with a confirmation after click). */
  label: string;
  /** How long the success label shows before reverting (ms, default 1200). */
  feedbackMs?: number;
}

/**
 * Tiny button that writes `text` to the clipboard. Shows "✓ copied" briefly
 * on success, "✗ failed" on error (e.g., insecure context where Clipboard API
 * is unavailable). Designed for inline use next to small copyable identifiers.
 */
export function CopyBtn({ text, label, feedbackMs = 1200 }: Props) {
  const [state, setState] = useState<'idle' | 'ok' | 'err'>('idle');

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setState('ok');
    } catch {
      setState('err');
    }
    setTimeout(() => setState('idle'), feedbackMs);
  }

  const display = state === 'ok' ? '✓ copied'
                : state === 'err' ? '✗ failed'
                : label;

  return (
    <button
      data-testid="copy-btn"
      onClick={copy}
      title={`Copy: ${text}`}
      style={{
        fontSize: 11,
        padding: '2px 6px',
        marginLeft: 6,
        cursor: 'pointer',
        border: '1px solid #444',
        borderRadius: 3,
        background: state === 'ok' ? '#1a3a1a' : state === 'err' ? '#3a1a1a' : '#222',
        color: '#ccc',
      }}
    >
      {display}
    </button>
  );
}
