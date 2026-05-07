import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from 'preact';
import { RateLimitsPill } from './RateLimitsPill.js';
import { rateLimitsBySession, applyRateLimits } from '../store.js';

const mounted: HTMLDivElement[] = [];

beforeEach(() => {
  rateLimitsBySession.value = {};
});

afterEach(() => {
  // Tear down each mount so the component's setInterval cleanup fires;
  // otherwise timers leak across tests and can produce flake.
  for (const div of mounted) render(null, div);
  mounted.length = 0;
});

function mount(sessionId: string): HTMLDivElement {
  const div = document.createElement('div');
  render(<RateLimitsPill sessionId={sessionId} />, div);
  mounted.push(div);
  return div;
}

describe('RateLimitsPill', () => {
  it('does not render when no entry exists for the session', () => {
    const div = mount('s1');
    expect(div.firstChild).toBeNull();
  });

  it('does not render when both windows are null (API-key user)', () => {
    applyRateLimits('s1', { five_hour: null, seven_day: null, observed_at: Date.now() });
    const div = mount('s1');
    expect(div.firstChild).toBeNull();
  });

  it('renders both windows when fresh', () => {
    const now = Date.now();
    applyRateLimits('s1', {
      five_hour: { used_percentage: 45, resets_at: Math.floor(now / 1000) + 7320 },
      seven_day: { used_percentage: 23, resets_at: Math.floor(now / 1000) + 86400 },
      observed_at: now,
    });
    const div = mount('s1');
    expect(div.textContent).toMatch(/5h:\s*45%/);
    expect(div.textContent).toMatch(/7d:\s*23%/);
  });

  it('applies amber color when 5h utilization is in [70, 90)', () => {
    applyRateLimits('s1', {
      five_hour: { used_percentage: 80, resets_at: Math.floor(Date.now() / 1000) + 100 },
      seven_day: null,
      observed_at: Date.now(),
    });
    const div = mount('s1');
    const el = div.firstChild as HTMLElement;
    expect(el.style.color).toBe('rgb(245, 158, 11)');
  });

  it('applies red color when 5h utilization >= 90', () => {
    applyRateLimits('s1', {
      five_hour: { used_percentage: 95, resets_at: Math.floor(Date.now() / 1000) + 100 },
      seven_day: null,
      observed_at: Date.now(),
    });
    const div = mount('s1');
    expect((div.firstChild as HTMLElement).style.color).toBe('rgb(239, 68, 68)');
  });

  it('dims when observed_at is older than 10 minutes', () => {
    applyRateLimits('s1', {
      five_hour: { used_percentage: 10, resets_at: Math.floor(Date.now() / 1000) + 100 },
      seven_day: null,
      observed_at: Date.now() - 11 * 60 * 1000,
    });
    const div = mount('s1');
    expect((div.firstChild as HTMLElement).style.opacity).toBe('0.5');
  });
});
