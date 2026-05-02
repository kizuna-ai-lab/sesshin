import type { PermissionMode } from '@sesshin/shared';

const CONFIG: Record<PermissionMode, { title: string; glyph: string; bg: string; fg: string } | null> = {
  default:           null,
  auto:              { title: 'Auto',    glyph: '⏵⏵', bg: '#5a4a00', fg: '#ffd966' },
  acceptEdits:       { title: 'Accept',  glyph: '⏵⏵', bg: '#003a4a', fg: '#79e2ff' },
  bypassPermissions: { title: 'Bypass',  glyph: '⏵⏵', bg: '#4a0000', fg: '#ff8080' },
  dontAsk:           { title: 'DontAsk', glyph: '⏵⏵', bg: '#4a0000', fg: '#ff8080' },
  plan:              { title: 'Plan',    glyph: '⏸',  bg: '#3a004a', fg: '#d29eff' },
};

export function ModeBadge({ mode }: { mode: PermissionMode }) {
  const c = CONFIG[mode];
  if (!c) return null;
  return (
    <span data-testid="mode-badge" style={{
      padding: '2px 8px', borderRadius: 4, fontFamily: 'monospace', fontSize: 12,
      background: c.bg, color: c.fg,
    }}>{c.glyph} {c.title}</span>
  );
}
