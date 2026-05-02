---
description: List remote clients (web/IM/device adapters) currently subscribed to this session
allowed-tools: Bash(sesshin clients:*)
---

```bash
sesshin clients --session $SESSHIN_SESSION_ID --json
```

For each client, show: kind (debug-web / telegram-adapter / m5stick / ...), declared capabilities, subscription set.
