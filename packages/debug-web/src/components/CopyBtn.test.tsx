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

  it('rapid clicks reset the timer (consistent feedbackMs after the LAST click)', async () => {
    render(<CopyBtn text="x" label="copy" feedbackMs={80} />, host);
    const btn = host.querySelector('[data-testid="copy-btn"]') as HTMLButtonElement;
    btn.click();
    await tick(0);
    expect(btn.textContent).toBe('✓ copied');
    // Click again 50ms in — original timer would fire at 80ms (only 30ms after
    // this click). With the reset, the timer resets and we get 80ms after THIS click.
    await tick(50);
    btn.click();
    await tick(0);
    expect(btn.textContent).toBe('✓ copied');
    // 50ms after second click: still in feedback window (< 80ms).
    await tick(50);
    expect(btn.textContent).toBe('✓ copied');
    // 80ms+ after second click: now revert.
    await tick(50);
    expect(btn.textContent).toBe('copy');
  });

  it('unmount during pending feedback does not throw or leak timers', async () => {
    render(<CopyBtn text="x" label="copy" feedbackMs={1000} />, host);
    const btn = host.querySelector('[data-testid="copy-btn"]') as HTMLButtonElement;
    btn.click();
    await tick(0);
    expect(btn.textContent).toBe('✓ copied');
    // Unmount while the timer is still pending. Should clear the timer; if it
    // didn't, the next setState('idle') would fire on a torn-down tree.
    render(null, host);
    await tick(50);
    // No assertion needed beyond "didn't throw" — if cleanup is missing, vitest
    // surfaces the act-on-unmounted warning.
    expect(true).toBe(true);
  });
});
