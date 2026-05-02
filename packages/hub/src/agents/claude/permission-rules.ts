/**
 * Port of claude's permission-rule parser + matcher.
 *
 * Claude rule format: `Tool` (matches all uses) or `Tool(content)` (tool-specific pattern).
 * Wildcard suffix `:*` for Bash prefix-match; `/*` for file-tool dir glob.
 *
 * See claude source: utils/permissions/permissionRuleParser.ts (parse/format)
 * and utils/permissions/permissions.ts:238 (toolMatchesRule).
 */

export interface ParsedRule { toolName: string; ruleContent: string | null }

const TOOL_RE = /^([A-Za-z_][A-Za-z0-9_]*)(?:\((.*)\))?$/s;

function unescape(s: string): string {
  return s.replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\\/g, '\\');
}
function escape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

export function parseRuleString(s: string): ParsedRule | null {
  const m = TOOL_RE.exec(s.trim());
  if (!m) return null;
  const toolName = m[1]!;
  const raw = m[2];
  return {
    toolName,
    ruleContent: raw === undefined ? null : unescape(raw),
  };
}

export function formatRuleString(toolName: string, content: string | null): string {
  return content === null ? toolName : `${toolName}(${escape(content)})`;
}

export function matchRule(
  toolName: string,
  toolInput: Record<string, unknown>,
  rule: ParsedRule,
): boolean {
  if (rule.toolName !== toolName) return false;
  if (rule.ruleContent === null) return true;     // bare tool name → matches all

  switch (toolName) {
    case 'Bash':
    case 'PowerShell': {
      const command = typeof toolInput['command'] === 'string' ? toolInput['command'] : '';
      const c = rule.ruleContent;
      if (c.endsWith(':*')) {
        const prefix = c.slice(0, -2);
        if (command === prefix) return true;
        // Word boundary: next char after prefix must be whitespace
        return command.length > prefix.length
          && command.startsWith(prefix)
          && /\s/.test(command[prefix.length]!);
      }
      return command === c;
    }
    case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': {
      const fp = typeof toolInput['file_path'] === 'string' ? toolInput['file_path'] : '';
      const c = rule.ruleContent;
      if (c.endsWith('/*')) {
        const prefix = c.slice(0, -2);
        return fp === prefix || fp.startsWith(prefix + '/');
      }
      return fp === c;
    }
    case 'WebFetch': case 'WebSearch': {
      const url = typeof toolInput['url'] === 'string' ? toolInput['url']
                : typeof toolInput['query'] === 'string' ? toolInput['query']
                : '';
      const c = rule.ruleContent;
      if (c.endsWith('/*')) return url.startsWith(c.slice(0, -2));
      return url === c;
    }
    default: {
      // Catch-all for tools we don't have specific matchers for.
      //
      // Limitation: JSON.stringify key order follows insertion order, so a
      // hand-written rule must match the exact key order claude emits. This
      // mirrors claude's upstream behavior — sesshin doesn't try to canonicalize
      // because doing so would diverge from claude's own matching semantics.
      // Practical recommendation: for custom tools, prefer the bare-toolname
      // form (e.g., `mcp__server__doStuff`) which matches all calls, or rely on
      // the sessionAllowList populated by handler `sessionAllowAdd` (which uses
      // JSON.stringify on the same input shape, so the round-trip is consistent).
      return JSON.stringify(toolInput) === rule.ruleContent;
    }
  }
}

export function ruleMatchesAny(
  toolName: string,
  toolInput: Record<string, unknown>,
  ruleStrings: readonly string[],
): boolean {
  for (const s of ruleStrings) {
    const r = parseRuleString(s);
    if (r && matchRule(toolName, toolInput, r)) return true;
  }
  return false;
}
