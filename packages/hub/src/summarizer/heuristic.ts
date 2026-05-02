export interface HeuristicResult {
  oneLine: string;
  bullets: string[];
  needsDecision: false;
  suggestedNext: null;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
}

export function heuristicSummary(rawTail: string): HeuristicResult {
  const lines = stripAnsi(rawTail).split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const last = lines[lines.length - 1] ?? '';
  const bullets = lines.slice(-5, -1).reverse().slice(0, 4);
  return {
    oneLine: last.slice(0, 100),
    bullets: bullets.map((b) => b.slice(0, 80)),
    needsDecision: false,
    suggestedNext: null,
  };
}
