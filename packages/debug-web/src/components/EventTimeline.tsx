import type { Event } from '@sesshin/shared';
export function EventTimeline({ events }: { events: Event[] }) {
  return (
    <ul style={{ listStyle: 'none', padding: 0, fontFamily: 'monospace', fontSize: 12 }}>
      {events.map((e) => (
        <li key={e.eventId} data-testid="event-row" style={{ padding: '2px 4px', borderBottom: '1px solid #222' }}>
          <span style={{ opacity: 0.5 }}>{new Date(e.ts).toLocaleTimeString()}</span>{' '}
          <b>{e.kind}</b>{' '}
          <span style={{ opacity: 0.7 }}>[{e.source}]</span>{' '}
          <code>{shorten(JSON.stringify(e.payload), 80)}</code>
        </li>
      ))}
    </ul>
  );
}
function shorten(s: string, n: number): string { return s.length > n ? s.slice(0, n) + '…' : s; }
