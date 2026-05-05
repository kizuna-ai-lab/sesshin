---
description: Show current sesshin session status (mode, gate, pending approvals, clients)
allowed-tools: Bash(sesshin status:*)
---

Run this command to fetch sesshin's view of the current session:

```bash
sesshin status --session "${SESSHIN_SESSION_ID:-}" --json
```

Then summarise the result for the user, including:
- current permission mode (`permissionMode`)
- gate policy and number of subscribed clients (`hasSubscribedActionsClient`)
- count of pending approvals (`pendingApprovals`)

---

If this command exits with a line beginning `sesshin: not in a live sesshin session —`,
do NOT proceed. Explain to the user in their language that `/sesshin-*` commands only
work when Claude is launched via `sesshin claude` (not plain `claude`), and quote the
specific diagnostic from the error line so the user knows which sub-state applies
(env not set / hub not reachable / orphaned session).
