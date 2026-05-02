import { useState } from 'preact/hooks';
import type { Event } from '@sesshin/shared';

const pad = (n: number, w: number): string => String(n).padStart(w, '0');

export function formatLocalMs(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}.${pad(d.getMilliseconds(), 3)}`;
}

function shorten(s: string, n: number): string { return s.length > n ? s.slice(0, n) + '…' : s; }

function EventRow({ e }: { e: Event }) {
  const [open, setOpen] = useState(false);
  const oneLine = JSON.stringify(e.payload);
  return (
    <li data-testid="event-row" style={{ padding: '2px 4px', borderBottom: '1px solid #222' }}>
      <div
        onClick={() => setOpen(!open)}
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'baseline', gap: 6, userSelect: 'none' }}
        data-testid="event-row-header"
      >
        <span style={{ opacity: 0.5, width: 96, flexShrink: 0 }}>{formatLocalMs(e.ts)}</span>
        <span style={{ width: 12, opacity: 0.5, flexShrink: 0 }}>{open ? '▾' : '▸'}</span>
        <b>{e.kind}</b>
        <span style={{ opacity: 0.6 }}>[{e.source}]</span>
        {!open && <code style={{ opacity: 0.85 }}>{shorten(oneLine, 80)}</code>}
      </div>
      {open && (
        <pre
          data-testid="event-detail"
          style={{
            margin: '4px 0 4px 116px',
            padding: 8,
            background: '#111',
            color: '#ddd',
            borderRadius: 4,
            fontSize: 12,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >{JSON.stringify(e.payload, null, 2)}</pre>
      )}
    </li>
  );
}

export function EventTimeline({ events }: { events: Event[] }) {
  return (
    <ul style={{ listStyle: 'none', padding: 0, fontFamily: 'monospace', fontSize: 12 }}>
      {events.map((e) => <EventRow key={e.eventId} e={e} />)}
    </ul>
  );
}
