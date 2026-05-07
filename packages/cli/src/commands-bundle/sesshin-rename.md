---
description: Rename the current sesshin session
allowed-tools: Bash(sesshin rename:*)
argument-hint: <new name>
---

```bash
sesshin rename ${ARGUMENTS:-} --session "${SESSHIN_SESSION_ID:-}"
```

Confirm rename status in the output. On success the command prints
`renamed to <name>` to stdout. On failure (e.g. empty name, or session not
found) it exits non-zero with a `rename failed: <status> <body>` diagnostic
on stderr — quote the body's `code` (e.g. `lifecycle.payload-required`) when
reporting back.

---

If this command exits with a line beginning `sesshin: not in a live sesshin session —`,
do NOT proceed. Explain to the user in their language that `/sesshin-*` commands only
work when Claude is launched via `sesshin claude` (not plain `claude`), and quote the
specific diagnostic from the error line so the user knows which sub-state applies
(env not set / hub not reachable / orphaned session).
