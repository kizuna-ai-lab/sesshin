import type { SessionState } from '@sesshin/shared';
const COLORS: Record<SessionState, string> = {
  starting: '#888', idle: '#5a5', running: '#5cf',
  'awaiting-input': '#fc5', 'awaiting-confirmation': '#f95',
  error: '#f55', done: '#888', interrupted: '#888',
};
export function StateBadge({ state }: { state: SessionState }) {
  return <span data-testid="state-badge" style={{ padding: '2px 8px', borderRadius: 4, background: COLORS[state], color: '#000' }}>{state}</span>;
}
