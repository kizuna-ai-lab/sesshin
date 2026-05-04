---
description: List remote clients (web/IM/device adapters) currently subscribed to this session
allowed-tools: Bash(sesshin clients:*)
---

Run this command to fetch the subscribed-clients list:

```bash
sesshin clients --session "${SESSHIN_SESSION_ID:-}" --json
```

Then summarise: for each client, show its kind (debug-web / telegram-adapter / m5stick / …), declared capabilities, and subscription set.

---

If this command exits with a line beginning `sesshin: not in a live sesshin session —`,
do NOT proceed. Explain to the user in their language that `/sesshin-*` commands only
work when Claude is launched via `sesshin claude` (not plain `claude`), and quote the
specific diagnostic from the error line so the user knows which sub-state applies
(env not set / hub not reachable / orphaned session).
