---
description: Add a sesshin session-allow rule (Tool[(content)]) so future matching tool calls skip the remote-approval prompt
allowed-tools: Bash(sesshin trust:*)
argument-hint: <Tool(content)>
---

Run this command to register the rule:

```bash
sesshin trust "${ARGUMENTS}" --session "${SESSHIN_SESSION_ID:-}"
```

Then confirm to the user that the rule was added and explain that future tool calls matching it will skip the remote-approval gate (still subject to claude's own permission rules).

---

If this command exits with a line beginning `sesshin: not in a live sesshin session —`,
do NOT proceed. Explain to the user in their language that `/sesshin-*` commands only
work when Claude is launched via `sesshin claude` (not plain `claude`), and quote the
specific diagnostic from the error line so the user knows which sub-state applies
(env not set / hub not reachable / orphaned session).
