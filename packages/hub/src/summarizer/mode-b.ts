import { spawn } from 'node:child_process';

export interface ModeBInput {
  /** Defaults to 'claude' on PATH. */
  binary?: string;
  /** Defaults to a sensible argv for our use. Override allows tests. */
  args?: string[];
  prompt: string;
  instructions: string;
  model: string;
  timeoutMs: number;
}

export interface ModeBResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export async function runModeB(input: ModeBInput): Promise<ModeBResult> {
  const bin = input.binary ?? 'claude';
  const args = input.args ?? [
    '-p', '--model', input.model, '--output-format', 'json',
    '--tools', '', '--no-session-persistence',
    '--exclude-dynamic-system-prompt-sections',
    '--system-prompt', input.instructions,
    input.prompt,
  ];

  return new Promise<ModeBResult>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error('mode-b timeout'));
    }, input.timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`mode-b exit ${code}: ${err.slice(0, 500)}`));
      try {
        const j = JSON.parse(out);
        resolve({
          text: j.result ?? '',
          inputTokens: j.usage?.input_tokens ?? 0,
          outputTokens: j.usage?.output_tokens ?? 0,
          model: j.model ?? input.model,
        });
      } catch (e) { reject(new Error('mode-b parse: ' + String(e))); }
    });
  });
}
