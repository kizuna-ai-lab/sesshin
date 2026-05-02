import { describe, it, expect, beforeEach } from 'vitest';
import { render } from 'preact';
import { InteractionPanel } from './InteractionPanel.js';
import { promptRequestsBySession, addPromptRequest } from '../store.js';
import type { WsClient } from '../ws-client.js';

const stub: WsClient = {
  sendAction: () => {}, sendText: () => {},
  sendPromptResponse: () => {}, close: () => {},
};

describe('InteractionPanel', () => {
  beforeEach(() => { promptRequestsBySession.value = {}; });

  it('renders nothing when no pending requests', () => {
    const div = document.createElement('div');
    render(<InteractionPanel ws={stub} sessionId="s1" />, div);
    expect(div.querySelector('[data-testid="interaction-panel"]')).toBeNull();
  });

  it('renders a permission card with options', () => {
    addPromptRequest({
      sessionId: 's1', requestId: 'r1', origin: 'permission', toolName: 'Bash',
      body: '```bash\ngit log\n```',
      questions: [{
        prompt: 'Run this command?', header: 'Bash',
        multiSelect: false, allowFreeText: true,
        options: [
          { key: 'yes',        label: 'Yes' },
          { key: 'yes-prefix', label: 'Yes, don’t ask again' },
          { key: 'no',         label: 'No' },
        ],
      }],
      expiresAt: Date.now() + 60_000,
    });
    const div = document.createElement('div');
    render(<InteractionPanel ws={stub} sessionId="s1" />, div);
    expect(div.querySelector('[data-testid="interaction-panel"]')).toBeTruthy();
    const buttons = div.querySelectorAll('[data-testid^="opt-"]');
    expect(buttons.length).toBe(3);
  });

  it('clicking an option calls sendPromptResponse with the key', async () => {
    let captured: any = null;
    const ws: WsClient = { ...stub, sendPromptResponse: (sid, rid, answers) => { captured = { sid, rid, answers }; } };
    addPromptRequest({
      sessionId: 's1', requestId: 'r1', origin: 'permission', toolName: 'Bash',
      questions: [{
        prompt: 'Run this command?', multiSelect: false, allowFreeText: false,
        options: [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }],
      }],
      expiresAt: Date.now() + 60_000,
    });
    const div = document.createElement('div');
    render(<InteractionPanel ws={ws} sessionId="s1" />, div);
    (div.querySelector('[data-testid="opt-yes"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(captured).toMatchObject({
      sid: 's1', rid: 'r1',
      answers: [{ questionIndex: 0, selectedKeys: ['yes'] }],
    });
  });

  it('typing in the free-text input sends freeText with the answer', async () => {
    let captured: any = null;
    const ws: WsClient = { ...stub, sendPromptResponse: (sid, rid, answers) => { captured = { sid, rid, answers }; } };
    addPromptRequest({
      sessionId: 's1', requestId: 'r-ft', origin: 'permission', toolName: 'Bash',
      questions: [{
        prompt: 'Run this?', multiSelect: false, allowFreeText: true,
        options: [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }],
      }],
      expiresAt: Date.now() + 60_000,
    });
    const div = document.createElement('div');
    render(<InteractionPanel ws={ws} sessionId="s1" />, div);

    // Type into the free-text input
    const input = div.querySelector('input') as HTMLInputElement;
    input.value = 'note text';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    // Wait for Preact to flush state update so the next render's closure has the new freeText
    await new Promise((r) => setTimeout(r, 0));

    // Click "yes" — single-question single-select auto-submits
    (div.querySelector('[data-testid="opt-yes"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));

    expect(captured).toMatchObject({
      sid: 's1', rid: 'r-ft',
      answers: [{ questionIndex: 0, selectedKeys: ['yes'], freeText: 'note text' }],
    });
  });

  it('Submit is disabled when a multi-select question has no selection and no free-text allowed', () => {
    addPromptRequest({
      sessionId: 's1', requestId: 'r-ms', origin: 'ask-user-question', toolName: 'AskUserQuestion',
      questions: [{
        prompt: 'Pick any', multiSelect: true, allowFreeText: false,
        options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }],
      }],
      expiresAt: Date.now() + 60_000,
    });
    const div = document.createElement('div');
    render(<InteractionPanel ws={stub} sessionId="s1" />, div);
    const submit = Array.from(div.querySelectorAll('button')).find(b => b.textContent === 'Submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });
});
