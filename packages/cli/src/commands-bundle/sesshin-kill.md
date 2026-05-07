---
description: Terminate the wrapped Claude Code process (SIGTERM, then SIGKILL after timeout)
allowed-tools: Bash(sesshin kill:*)
---

```bash
sesshin kill --session "${SESSHIN_SESSION_ID:-}"
```

Confirm termination status in the output. On success the command prints
`kill requested` to stdout (the actual process termination is asynchronous —
the hub sends SIGTERM immediately and escalates to SIGKILL after a short
timeout if the process is still alive). On failure (e.g. session already in a
terminal state) it exits non-zero with a `kill failed: <status> <body>`
diagnostic on stderr — quote the body's `code` (e.g.
`lifecycle.invalid-state`) when reporting back.

---

If this command exits with a line beginning `sesshin: not in a live sesshin session —`,
do NOT proceed. Explain to the user in their language that `/sesshin-*` commands only
work when Claude is launched via `sesshin claude` (not plain `claude`), and quote the
specific diagnostic from the error line so the user knows which sub-state applies
(env not set / hub not reachable / orphaned session).
