import { describe, it, expect } from 'vitest';
import { runModeB } from './mode-b.js';

describe('runModeB', () => {
  it('parses claude -p JSON output', async () => {
    // Use `node -e` as a stand-in for claude that emits the json shape claude -p produces.
    const stub = process.execPath;
    const stubArgs = ['-e', `process.stdout.write(JSON.stringify({result: '{"oneLine":"hi","bullets":[],"needsDecision":false,"suggestedNext":null}', usage:{input_tokens:1,output_tokens:1}}))`];
    const r = await runModeB({
      binary: stub, args: stubArgs, prompt: 'ignored', instructions: 'ignored', model: 'claude-haiku-4-5', timeoutMs: 5000,
    });
    expect(r.text).toContain('hi');
  });
  it('throws on non-zero exit', async () => {
    await expect(runModeB({
      binary: process.execPath, args: ['-e', 'process.exit(1)'],
      prompt: 'p', instructions: 'i', model: 'm', timeoutMs: 1000,
    })).rejects.toThrow();
  });
  it('throws on timeout', async () => {
    await expect(runModeB({
      binary: process.execPath, args: ['-e', 'setTimeout(()=>{},5000)'],
      prompt: 'p', instructions: 'i', model: 'm', timeoutMs: 100,
    })).rejects.toThrow();
  });
});
