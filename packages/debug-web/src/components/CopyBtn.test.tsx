/// <reference lib="dom" />
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from 'preact';
import { CopyBtn } from './CopyBtn.js';

let host: HTMLElement;
let writeText: ReturnType<typeof vi.fn>;
let origClipboard: PropertyDescriptor | undefined;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  writeText = vi.fn().mockResolvedValue(undefined);
  origClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  render(null, host);
  host.remove();
  if (origClipboard) Object.defineProperty(navigator, 'clipboard', origClipboard);
  else delete (navigator as { clipboard?: unknown }).clipboard;
});

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('CopyBtn', () => {
  it('renders the label until clicked', () => {
    render(<CopyBtn text="abc" label="copy id" />, host);
    const btn = host.querySelector('[data-testid="copy-btn"]') as HTMLButtonElement;
    expect(btn.textContent).toBe('copy id');
  });

  it('writes to navigator.clipboard on click and shows "✓ copied"', async () => {
    render(<CopyBtn text="hello" label="copy" feedbackMs={500} />, host);
    const btn = host.querySelector('[data-testid="copy-btn"]') as HTMLButtonElement;
    btn.click();
    await tick(0);                  // flush clipboard.writeText resolution + setState re-render
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(btn.textContent).toBe('✓ copied');
  });

  it('reverts the label after feedbackMs', async () => {
    render(<CopyBtn text="x" label="copy" feedbackMs={50} />, host);
    const btn = host.querySelector('[data-testid="copy-btn"]') as HTMLButtonElement;
    btn.click();
    await tick(0);
    expect(btn.textContent).toBe('✓ copied');
    await tick(80);                 // wait past the 50ms feedbackMs
    expect(btn.textContent).toBe('copy');
  });

  it('shows "✗ failed" when clipboard rejects', async () => {
    writeText.mockRejectedValueOnce(new Error('insecure context'));
    render(<CopyBtn text="x" label="copy" feedbackMs={300} />, host);
    const btn = host.querySelector('[data-testid="copy-btn"]') as HTMLButtonElement;
    btn.click();
    await tick(0);
    expect(btn.textContent).toBe('✗ failed');
  });

  it('puts the full text in the title attribute (so hover reveals long paths)', () => {
    render(<CopyBtn text="/very/long/path/to/transcript.jsonl" label="copy" />, host);
    const btn = host.querySelector('[data-testid="copy-btn"]') as HTMLButtonElement;
    expect(btn.title).toContain('/very/long/path/to/transcript.jsonl');
  });
});
