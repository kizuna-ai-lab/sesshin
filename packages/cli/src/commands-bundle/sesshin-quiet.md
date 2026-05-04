---
description: Suspend remote notifications for a duration (e.g. 5m, 30s, 1h, or 'off' to clear)
allowed-tools: Bash(sesshin quiet:*)
argument-hint: <duration|off>
---

```bash
sesshin quiet "${ARGUMENTS:-off}" --session "${SESSHIN_SESSION_ID:-}"
```

Confirm the quiet window or that it was cleared. Don't editorialize.

---

If this command exits with a line beginning `sesshin: not in a live sesshin session —`,
do NOT proceed. Explain to the user in their language that `/sesshin-*` commands only
work when Claude is launched via `sesshin claude` (not plain `claude`), and quote the
specific diagnostic from the error line so the user knows which sub-state applies
(env not set / hub not reachable / orphaned session).
