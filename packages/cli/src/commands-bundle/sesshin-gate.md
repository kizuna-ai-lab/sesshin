---
description: Override the per-session gate policy (disabled / auto / always)
allowed-tools: Bash(sesshin gate:*)
argument-hint: <disabled|auto|always>
---

```bash
sesshin gate "${ARGUMENTS}" --session $SESSHIN_SESSION_ID
```

Confirm the new policy. Briefly explain: `disabled` = sesshin never gates, `auto` = mode-aware gating (default), `always` = every PreToolUse goes through the remote prompt regardless of mode.
