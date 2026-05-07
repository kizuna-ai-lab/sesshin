import { useEffect, useState } from 'preact/hooks';
import { rateLimitsBySession } from '../store.js';
import type { RateLimitsState } from '@sesshin/shared';

const COLOR_DEFAULT = '#eee';
const COLOR_AMBER   = 'rgb(245, 158, 11)';
const COLOR_RED     = 'rgb(239, 68, 68)';
const STALE_MS      = 10 * 60 * 1000;

interface Props { sessionId: string; }

export function RateLimitsPill({ sessionId }: Props) {
  const [, force] = useState(0);

  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const state = rateLimitsBySession.value[sessionId];
  if (!state) return null;
  if (!state.five_hour && !state.seven_day) return null;

  const now = Date.now();
  const stale = now - state.observed_at >= STALE_MS;
  const five  = state.five_hour;
  const seven = state.seven_day;

  const fivePart  = five  ? `5h: ${Math.round(five.used_percentage)}%`  : '5h: -';
  const sevenPart = seven ? `7d: ${Math.round(seven.used_percentage)}%` : '7d: -';

  const reset = five ?? seven;
  const resetMs = reset ? reset.resets_at * 1000 - now : null;
  const resetPart = resetMs !== null && resetMs > 0 ? ` · in ${formatDuration(resetMs)}` : '';

  const fiveColor = (() => {
    if (!five) return COLOR_DEFAULT;
    if (five.used_percentage >= 90) return COLOR_RED;
    if (five.used_percentage >= 70) return COLOR_AMBER;
    return COLOR_DEFAULT;
  })();

  const tooltip = buildTooltip(state, now);

  return (
    <span
      title={tooltip}
      data-testid="rate-limits-pill"
      style={{
        fontSize: 12,
        padding: '2px 6px',
        borderRadius: 4,
        background: '#1a1a1a',
        color: fiveColor,
        opacity: stale ? 0.5 : 1,
      }}
    >
      {stale && '⏱ '}
      {fivePart} · {sevenPart}{resetPart}
    </span>
  );
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const days  = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins  = Math.floor((totalSec % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function buildTooltip(state: RateLimitsState, now: number): string {
  const lines: string[] = [];
  if (state.five_hour) {
    const ms = state.five_hour.resets_at * 1000 - now;
    const at = new Date(state.five_hour.resets_at * 1000).toLocaleTimeString();
    lines.push(`5h window: ${state.five_hour.used_percentage.toFixed(1)}% used, resets at ${at} (in ${formatDuration(Math.max(0, ms))})`);
  }
  if (state.seven_day) {
    const ms = state.seven_day.resets_at * 1000 - now;
    const at = new Date(state.seven_day.resets_at * 1000).toLocaleString();
    lines.push(`7d window: ${state.seven_day.used_percentage.toFixed(1)}% used, resets ${at} (in ${formatDuration(Math.max(0, ms))})`);
  }
  const ageSec = Math.floor((now - state.observed_at) / 1000);
  lines.push(`last update: ${ageSec}s ago`);
  return lines.join('\n');
}
