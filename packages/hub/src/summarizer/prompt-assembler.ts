export interface AssembleInput {
  previousSummary: { oneLine: string; bullets: string[] } | null;
  events: { kind: 'user-prompt' | 'tool-call' | 'tool-result' | 'agent-output' | 'error'; text: string }[];
  maxChars: number;
}

const PER_ITEM_MAX = 500;

export function assemblePrompt(opts: AssembleInput): string {
  const lines: string[] = [];
  if (opts.previousSummary) {
    lines.push('PREVIOUS SUMMARY:');
    lines.push(opts.previousSummary.oneLine);
    for (const b of opts.previousSummary.bullets) lines.push('- ' + b);
    lines.push('');
  }
  lines.push('NEW EVENTS:');
  const trunc = (s: string): string => (s.length > PER_ITEM_MAX ? s.slice(0, PER_ITEM_MAX) + '...' : s);
  const items = opts.events.map((e) => `[${e.kind}] ${trunc(e.text)}`);
  // Always retain the first user-prompt and the last agent-output if present.
  const firstUserIdx = items.findIndex((s) => s.startsWith('[user-prompt]'));
  const lastOutIdx = (() => {
    for (let i = items.length - 1; i >= 0; i--) if (items[i]!.startsWith('[agent-output]')) return i;
    return -1;
  })();
  let head = items.slice();
  while (head.join('\n').length + lines.join('\n').length > opts.maxChars && head.length > 2) {
    // Drop the middle index that isn't the protected first/last.
    const mid = Math.floor(head.length / 2);
    const protected_ = new Set([firstUserIdx, lastOutIdx].filter((x) => x >= 0));
    let candidate = mid;
    while (protected_.has(candidate) && candidate < head.length - 1) candidate++;
    head.splice(candidate, 1);
  }
  return [...lines, ...head].join('\n');
}
