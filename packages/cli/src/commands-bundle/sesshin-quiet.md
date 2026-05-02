---
description: Suspend remote notifications for a duration (e.g. 5m, 30s, 1h, or 'off' to clear)
allowed-tools: Bash(sesshin quiet:*)
argument-hint: <duration|off>
---

```bash
sesshin quiet ${ARGUMENTS:-off} --session $SESSHIN_SESSION_ID
```

Confirm the quiet window or that it was cleared. Don't editorialize.
