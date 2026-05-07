---
description: Suspend the wrapped Claude Code process (SIGSTOP)
allowed-tools: Bash(sesshin pause:*)
---

```bash
sesshin pause --session "${SESSHIN_SESSION_ID:-}"
```

Confirm pause status in the output. On success the command prints `paused` to
stdout. On failure (e.g. session not in an active state) it exits non-zero
with a `pause failed: <status> <body>` diagnostic on stderr — quote the body's
`code` (e.g. `lifecycle.invalid-state`) when reporting back.

---

If this command exits with a line beginning `sesshin: not in a live sesshin session —`,
do NOT proceed. Explain to the user in their language that `/sesshin-*` commands only
work when Claude is launched via `sesshin claude` (not plain `claude`), and quote the
specific diagnostic from the error line so the user knows which sub-state applies
(env not set / hub not reachable / orphaned session).
