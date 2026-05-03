---
description: Print the JSONL transcript path for the current session, or filter it by event type
allowed-tools: Bash(sesshin log:*)
---

Run `sesshin log --session $SESSHIN_SESSION_ID` to print the path of this
session's Claude Code transcript JSONL. Default output is just the path on
one line — composable with `less`, `cat`, or shell pipes.

For analysis without leaving the chat, use the `--filter <type>` flag to
stream only matching JSONL records. Common types:
- `permission-mode` — every recorded mode change
- `last-prompt` — turn boundaries
- `attachment` — file attachments
- `user` / `assistant` — message records

For live monitoring use `--tail` (delegates to `tail -F`, follows logrotate
and atomic rename cleanly).

Examples:

```bash
sesshin log --session $SESSHIN_SESSION_ID                        # just the path
sesshin log --session $SESSHIN_SESSION_ID --filter permission-mode
sesshin log --session $SESSHIN_SESSION_ID --json                 # {sessionId,path}
sesshin log --session $SESSHIN_SESSION_ID --tail                 # live stream
```

Then summarise the result for the user.
