import { describe, it, expect } from 'vitest';
import { render } from 'preact';
import { ModeBadge } from './ModeBadge.js';

describe('ModeBadge', () => {
  it('renders nothing for default mode', () => {
    const div = document.createElement('div');
    render(<ModeBadge mode="default" />, div);
    expect(div.querySelector('[data-testid="mode-badge"]')).toBeNull();
  });
  it('renders glyph + short title for non-default', () => {
    const div = document.createElement('div');
    render(<ModeBadge mode="auto" />, div);
    const b = div.querySelector('[data-testid="mode-badge"]')!;
    expect(b).toBeTruthy();
    expect(b.textContent).toContain('Auto');
    expect(b.textContent).toContain('⏵⏵');
  });
});
