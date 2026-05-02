---
description: Show last N remote-resolved permission decisions for this session
allowed-tools: Bash(sesshin history:*)
argument-hint: [N]
---

```bash
sesshin history --session $SESSHIN_SESSION_ID -n ${ARGUMENTS:-20} --json
```

Print each entry with timestamp (HH:MM:SS), tool name, decision (allow/deny/ask), and reason if any.
