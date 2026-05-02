---
description: Show current sesshin session status (mode, gate, pending approvals, clients)
allowed-tools: Bash(sesshin status:*)
---

Run this command to fetch sesshin's view of the current session:

```bash
sesshin status --session $SESSHIN_SESSION_ID --json
```

Then summarise the result for the user: current permission mode, gate policy, number of subscribed clients, count of pending approvals, any active session-allow rules.
