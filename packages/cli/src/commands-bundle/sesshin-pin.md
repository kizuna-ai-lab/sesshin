---
description: Set a sticky note shown on remote clients (empty argument clears it)
allowed-tools: Bash(sesshin pin:*)
argument-hint: [message]
---

```bash
sesshin pin "${ARGUMENTS:-}" --session "${SESSHIN_SESSION_ID:-}"
```

Confirm the pin (or that it was cleared if no message was given).

---

If this command exits with a line beginning `sesshin: not in a live sesshin session —`,
do NOT proceed. Explain to the user in their language that `/sesshin-*` commands only
work when Claude is launched via `sesshin claude` (not plain `claude`), and quote the
specific diagnostic from the error line so the user knows which sub-state applies
(env not set / hub not reachable / orphaned session).
