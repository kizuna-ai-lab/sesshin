---
description: Set a sticky note shown on remote clients (empty argument clears it)
allowed-tools: Bash(sesshin pin:*)
argument-hint: [message]
---

```bash
sesshin pin ${ARGUMENTS:-} --session $SESSHIN_SESSION_ID
```

Confirm the pin (or that it was cleared if no message was given).
