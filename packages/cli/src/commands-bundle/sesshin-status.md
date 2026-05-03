---
description: Show current sesshin session status (mode, gate, pending approvals, clients, permission-request gate)
allowed-tools: Bash(sesshin status:*)
---

Run this command to fetch sesshin's view of the current session:

```bash
sesshin status --session $SESSHIN_SESSION_ID --json
```

Then summarise the result for the user, including:
- current permission mode (`permissionMode`)
- gate policy and number of subscribed clients (`hasSubscribedActionsClient`)
- count of pending approvals (`pendingApprovals`)
- any active session-allow rules (`sessionAllowList`)
- whether sesshin's PermissionRequest HTTP hook has taken over for this session (`usesPermissionRequest`) — if true, PreToolUse no longer drives approvals; the PermissionRequest path does.
