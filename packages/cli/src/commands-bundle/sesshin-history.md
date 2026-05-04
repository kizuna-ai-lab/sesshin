---
description: Show last N remote-resolved permission decisions for this session
allowed-tools: Bash(sesshin history:*)
argument-hint: [N]
---

```bash
sesshin history --session "${SESSHIN_SESSION_ID:-}" -n ${ARGUMENTS:-20} --json
```

Print each entry with timestamp (HH:MM:SS), tool name, decision (allow/deny/ask), and reason if any.

---

If this command exits with a line beginning `sesshin: not in a live sesshin session —`,
do NOT proceed. Explain to the user in their language that `/sesshin-*` commands only
work when Claude is launched via `sesshin claude` (not plain `claude`), and quote the
specific diagnostic from the error line so the user knows which sub-state applies
(env not set / hub not reachable / orphaned session).
