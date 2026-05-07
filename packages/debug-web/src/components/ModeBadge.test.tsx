import { describe, it, expect } from 'vitest';
import { render } from 'preact';
import { ModeBadge } from './ModeBadge.js';

describe('ModeBadge', () => {
  it('renders a muted "Default" badge so users can see the mode explicitly', () => {
    const div = document.createElement('div');
    render(<ModeBadge mode="default" />, div);
    const b = div.querySelector('[data-testid="mode-badge"]')!;
    expect(b).toBeTruthy();
    expect(b.getAttribute('data-mode')).toBe('default');
    expect(b.textContent).toContain('Default');
  });
  it('renders glyph + short title for non-default', () => {
    const div = document.createElement('div');
    render(<ModeBadge mode="auto" />, div);
    const b = div.querySelector('[data-testid="mode-badge"]')!;
    expect(b).toBeTruthy();
    expect(b.getAttribute('data-mode')).toBe('auto');
    expect(b.textContent).toContain('Auto');
    expect(b.textContent).toContain('⏵⏵');
  });
});
