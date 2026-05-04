---
description: Override the per-session gate policy (disabled / auto / always)
allowed-tools: Bash(sesshin gate:*)
argument-hint: <disabled|auto|always>
---

```bash
sesshin gate "${ARGUMENTS}" --session "${SESSHIN_SESSION_ID:-}"
```

Confirm the new policy. Briefly explain: `disabled` = sesshin never gates, `auto` = mode-aware gating (default), `always` = every PreToolUse goes through the remote prompt regardless of mode.

---

If this command exits with a line beginning `sesshin: not in a live sesshin session —`,
do NOT proceed. Explain to the user in their language that `/sesshin-*` commands only
work when Claude is launched via `sesshin claude` (not plain `claude`), and quote the
specific diagnostic from the error line so the user knows which sub-state applies
(env not set / hub not reachable / orphaned session).
