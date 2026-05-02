import { describe, it, expect } from 'vitest';
import { render } from 'preact';
import { EventTimeline, formatLocalMs } from './EventTimeline.js';
import type { Event } from '@sesshin/shared';

const evt = (over: Partial<Event> = {}): Event => ({
  eventId: 'e1',
  sessionId: 's1',
  kind: 'tool-call',
  payload: { tool: 'Edit', input: { path: '/a/b/c.md' } },
  source: 'observer:hook-ingest',
  ts: 1_700_000_001_234,
  ...over,
});

describe('formatLocalMs', () => {
  it('formats local time HH:MM:SS.mmm with zero-padded ms', () => {
    // Construct a timestamp at known wall-clock millis to assert ms padding.
    const d = new Date(2026, 0, 1, 12, 34, 56, 7);
    expect(formatLocalMs(d.getTime())).toMatch(/^\d{2}:\d{2}:56\.007$/);
  });
});

describe('EventTimeline', () => {
  it('renders ms-precision time and a collapsed one-line preview by default', () => {
    const div = document.createElement('div');
    render(<EventTimeline events={[evt()]} />, div);
    const row = div.querySelector('[data-testid="event-row"]')!;
    expect(row).toBeTruthy();
    // ms precision: HH:MM:SS.mmm
    expect(row.textContent).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}/);
    // collapsed: no <pre> detail shown
    expect(div.querySelector('[data-testid="event-detail"]')).toBeNull();
  });

  it('clicking a row reveals the full payload formatted as JSON (indent 2)', async () => {
    const div = document.createElement('div');
    render(<EventTimeline events={[evt()]} />, div);
    const header = div.querySelector('[data-testid="event-row-header"]') as HTMLElement;
    header.click();
    // Preact defers re-renders triggered by useState; wait a microtask.
    await new Promise((r) => setTimeout(r, 0));
    const detail = div.querySelector('[data-testid="event-detail"]')!;
    expect(detail).toBeTruthy();
    // Pretty-printed JSON contains a newline + 2-space indent.
    expect(detail.textContent).toContain('\n  "tool"');
    expect(detail.textContent).toContain('"path": "/a/b/c.md"');
  });
});
