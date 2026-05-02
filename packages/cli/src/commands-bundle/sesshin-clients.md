---
description: List remote clients (web/IM/device adapters) currently subscribed to this session
allowed-tools: Bash(sesshin clients:*)
---

Run this command to fetch the subscribed-clients list:

```bash
sesshin clients --session $SESSHIN_SESSION_ID --json
```

Then summarise: for each client, show its kind (debug-web / telegram-adapter / m5stick / …), declared capabilities, and subscription set.
