---
description: Add a sesshin session-allow rule (Tool[(content)]) so future matching tool calls skip the remote-approval prompt
allowed-tools: Bash(sesshin trust:*)
argument-hint: <Tool(content)>
---

Run this command to register the rule:

```bash
sesshin trust "${ARGUMENTS}" --session $SESSHIN_SESSION_ID
```

Then confirm to the user that the rule was added and explain that future tool calls matching it will skip the remote-approval gate (still subject to claude's own permission rules).
