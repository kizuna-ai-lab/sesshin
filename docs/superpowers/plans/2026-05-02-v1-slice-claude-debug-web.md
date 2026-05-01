# Sesshin v1 First Slice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a working end-to-end vertical of Sesshin: `sesshin claude` wraps the user's claude session preserving their full experience; a hub daemon collects events from hooks + session JSONL + PTY tap; a Mode B′ direct-API summarizer emits one summary per turn; a browser at `http://127.0.0.1:9662` shows live state, summaries, event timeline, and can send action buttons or free-form text back into the running session.

**Architecture:** Three Node processes plus an in-browser SPA on the user's laptop. CLI wraps claude in a PTY and registers with a singleton hub daemon. Hub runs an HTTP/REST surface for the CLI and hook-handler binary, plus a public WS+HTTP for the browser. All event sources funnel into one normalized stream consumed by the state machine and summarizer; the browser subscribes via WS with capability negotiation. See `docs/superpowers/specs/2026-05-02-v1-slice-claude-debug-web-design.md` for full design context.

**Tech Stack:** TypeScript + Node 22 ESM, pnpm workspaces, tsup (build), vitest (test), Preact + Vite (debug web), node-pty (PTY wrap), `ws` (WebSocket), zod (schemas), tweetnacl (crypto), msw (Anthropic mocking in tests).

---

## Workspace and file structure

The repo currently contains design docs, prototypes, and the spec — no runtime code. This plan adds a `packages/` directory with five workspace packages.

```
sesshin/
├── package.json                          (NEW: workspace root)
├── pnpm-workspace.yaml                   (NEW)
├── tsconfig.base.json                    (NEW: shared TS config)
├── .nvmrc                                (NEW: 22)
├── .gitignore                            (existing — add /packages/*/dist, /packages/*/node_modules)
├── README.md                             (existing — add "Run" section in M10)
├── docs/                                 (existing)
├── prototypes/                           (existing)
└── packages/
    ├── shared/                           (M1)
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── tsup.config.ts
    │   ├── vitest.config.ts
    │   └── src/
    │       ├── index.ts                  barrel
    │       ├── crypto.ts                 NaCl secretbox helpers
    │       ├── hook-events.ts            normalized hook event vocabulary + per-agent maps
    │       ├── actions.ts                action enum + types
    │       ├── session.ts                SessionInfo, Substate, SessionState
    │       ├── summary.ts                Summary type + zod schema
    │       ├── events.ts                 Event type + zod schema
    │       └── protocol.ts               WS message types (ClientIdentify, ServerHello, ...) + schemas
    │
    ├── hook-handler/                     (M2)
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── tsup.config.ts
    │   ├── vitest.config.ts
    │   ├── bin/sesshin-hook-handler      shim that requires dist/main.cjs
    │   └── src/
    │       ├── main.ts                   entry: stdin → POST → exit 0
    │       └── normalize.ts              event-name normalization for claude
    │
    ├── hub/                              (M3-M6)
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── tsup.config.ts
    │   ├── vitest.config.ts
    │   ├── bin/sesshin-hub               shim
    │   └── src/
    │       ├── main.ts                   entry; starts both servers
    │       ├── config.ts                 ports, paths, env overrides
    │       ├── logger.ts                 thin pino wrapper
    │       ├── registry/
    │       │   ├── session-registry.ts
    │       │   └── checkpoint.ts
    │       ├── event-bus.ts              EventEmitter wrapper with typed channels
    │       ├── state-machine/
    │       │   ├── machine.ts            transitions table + applier
    │       │   └── substate.ts
    │       ├── agents/claude/
    │       │   ├── normalize-hook.ts
    │       │   ├── normalize-jsonl.ts
    │       │   ├── action-map.ts
    │       │   ├── session-file-path.ts
    │       │   ├── credentials.ts        read .credentials.json + atomic write back
    │       │   └── refresh-oauth.ts      POST to console.anthropic.com/v1/oauth/token
    │       ├── observers/
    │       │   ├── hook-ingest.ts
    │       │   ├── session-file-tail.ts
    │       │   ├── pty-tap.ts
    │       │   └── dedup.ts              cross-source dedup
    │       ├── summarizer/
    │       │   ├── index.ts              orchestrator
    │       │   ├── prompt-assembler.ts
    │       │   ├── mode-b-prime.ts       direct API call
    │       │   ├── mode-b.ts             claude -p subprocess fallback
    │       │   └── heuristic.ts
    │       ├── input-arbiter.ts
    │       ├── rest/
    │       │   ├── server.ts             HTTP on 9663 (loopback)
    │       │   └── handlers.ts           all loopback REST handlers
    │       ├── ws/
    │       │   ├── server.ts             public HTTP+WS on 9662
    │       │   ├── connection.ts         per-client state
    │       │   └── broadcast.ts
    │       └── shutdown.ts               30s grace timer + checkpoint flush
    │
    ├── cli/                              (M7-M8)
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── tsup.config.ts
    │   ├── vitest.config.ts
    │   ├── bin/sesshin                   shim
    │   └── src/
    │       ├── main.ts                   subcommand dispatch
    │       ├── hub-spawn.ts              auto-spawn + stale detection
    │       ├── settings-tempfile.ts      generate hooks-only settings JSON
    │       ├── settings-merge.ts         fallback when --settings replaces
    │       ├── pty-wrap.ts               node-pty + raw stdio passthrough
    │       ├── pty-tap.ts                tee output to hub via streaming POST
    │       ├── inject-listener.ts        WS subscription for hub→PTY input
    │       ├── heartbeat.ts
    │       ├── claude.ts                 the `sesshin claude` flow
    │       ├── cleanup.ts                signal handlers + tempfile reaping
    │       └── orphan-cleanup.ts         scan /tmp at startup
    │
    └── debug-web/                        (M9)
        ├── package.json
        ├── tsconfig.json
        ├── vite.config.ts
        ├── index.html
        └── src/
            ├── main.tsx
            ├── App.tsx
            ├── ws-client.ts              with reconnect + since-replay
            ├── store.ts                  Preact signals
            └── components/
                ├── SessionList.tsx
                ├── SessionDetail.tsx
                ├── StateBadge.tsx
                ├── SummaryCard.tsx
                ├── EventTimeline.tsx
                ├── ActionButtons.tsx
                └── TextInput.tsx
```

The hub package's `tsup.config.ts` includes a step that copies `packages/debug-web/dist/` into `packages/hub/dist/web/` so the hub serves it at `/`.

---

## Milestone overview

| Milestone | Outcome | Tasks |
|---|---|---|
| **M0** | Verification gates pass + workspace scaffold ready. | T1-T5 |
| **M1** | `@sesshin/shared` complete with all schemas + crypto. | T6-T11 |
| **M2** | `@sesshin/hook-handler` ships a working binary (no hub yet to talk to). | T12-T14 |
| **M3** | `@sesshin/hub` skeleton with REST surface + registry + checkpoint. | T15-T22 |
| **M4** | Hub state machine + observers wired up; events flow but no summarizer or WS yet. | T23-T31 |
| **M5** | Hub WS server with capability gating, broadcasting, and input arbitration. | T32-T38 |
| **M6** | Hub summarizer with Mode B′ + Mode B + heuristic. End of "hub is feature-complete." | T39-T44 |
| **M7** | `@sesshin/cli` minimal: PTY wrap, settings tempfile, hub spawn. `sesshin claude` runs claude untouched. | T45-T52 |
| **M8** | CLI bidirectional: hooks fire, summaries appear, input from hub injects to PTY. End-to-end via curl works. | T53-T57 |
| **M9** | `@sesshin/debug-web` complete and bundled into hub. Browser usable. | T58-T67 |
| **M10** | Stub-claude e2e test green; README + run docs; release-ready commit. | T68-T72 |

After each milestone, a checkpoint commit + integration sanity check. The plan continues below with each task spelled out in execution order.

---

## Milestone M0: Verification gates + workspace scaffold

The four gates from spec §7 run **before** any implementation code is written. Each gate's result is appended to `docs/validation-log.md` as a new "Section 12.x" entry.

### Task 1: Verification gate 1 — `--settings` hooks merge semantics

**Files:**
- Modify: `docs/validation-log.md` (append "## 12.1 Settings-merge verification (YYYY-MM-DD)")

- [ ] **Step 1: Probe whether `~/.claude/settings.json` already has hooks**

  Run: `python3 -c "import json; d=json.load(open('/home/jiangzhuo/.claude/settings.json')); print('existing hooks?', 'hooks' in d)"`

  Note the result. If hooks already exist, back up the file: `cp ~/.claude/settings.json ~/.claude/settings.json.bak.gate1`.

- [ ] **Step 2: Add a no-op user hook**

  Edit `~/.claude/settings.json` to add (preserving any existing keys):

  ```json
  {
    "hooks": {
      "Stop": [
        { "matcher": "*", "hooks": [
          { "type": "command", "command": "/bin/sh -c 'touch /tmp/sesshin-gate1-user-hook'" }
        ]}
      ]
    }
  }
  ```

- [ ] **Step 3: Write the test settings file**

  ```bash
  cat > /tmp/sesshin-gate1-test.json <<'EOF'
  {
    "hooks": {
      "Stop": [
        { "matcher": "*", "hooks": [
          { "type": "command", "command": "/bin/sh -c 'touch /tmp/sesshin-gate1-our-hook'" }
        ]}
      ]
    }
  }
  EOF
  ```

- [ ] **Step 4: Clear sentinel files and run claude with --settings**

  ```bash
  rm -f /tmp/sesshin-gate1-user-hook /tmp/sesshin-gate1-our-hook
  claude -p --settings /tmp/sesshin-gate1-test.json --model claude-haiku-4-5 'reply with one word'
  ```

- [ ] **Step 5: Check which sentinel files exist**

  ```bash
  ls -la /tmp/sesshin-gate1-*-hook 2>&1
  ```

  Three possible outcomes:
  - **Both files exist** → hooks MERGE. CLI uses the simple temp-file path. Record "MERGE" in validation log.
  - **Only `our-hook` exists** → `--settings` REPLACES user hooks. CLI MUST use the merge fallback (Task 50 implements this). Record "REPLACE" in validation log.
  - **Only `user-hook` exists or neither** → unexpected; investigate before proceeding.

- [ ] **Step 6: Append result to validation log**

  Add a new section `## 12.1 Settings-merge verification (run YYYY-MM-DD)` to `docs/validation-log.md` documenting:
  - The exact commands run
  - The sentinel-file outcome
  - The implication for CLI design (simple path vs. merge fallback)

- [ ] **Step 7: Restore original settings**

  ```bash
  if [ -f ~/.claude/settings.json.bak.gate1 ]; then
    mv ~/.claude/settings.json.bak.gate1 ~/.claude/settings.json
  fi
  rm -f /tmp/sesshin-gate1-test.json /tmp/sesshin-gate1-user-hook /tmp/sesshin-gate1-our-hook
  ```

- [ ] **Step 8: Commit**

  ```bash
  git add docs/validation-log.md
  git commit -m "validation: gate 1 settings-merge semantics result"
  ```

### Task 2: Verification gate 2 — Claude session JSONL location and format

**Files:**
- Modify: `docs/validation-log.md` (append "## 12.2 Session JSONL format")

- [ ] **Step 1: Discover the claude projects directory layout**

  ```bash
  ls ~/.claude/projects/ | head -10
  ls ~/.claude/projects/ | wc -l
  ```

  Pick one entry that corresponds to a recently-active cwd. Check the directory contents to find a `.jsonl` file.

- [ ] **Step 2: Inspect the JSONL schema (no values printed)**

  ```bash
  PROJECT_DIR=$(ls -td ~/.claude/projects/*/ | head -1)
  JSONL=$(ls -t "$PROJECT_DIR"*.jsonl 2>/dev/null | head -1)
  echo "Latest JSONL: $JSONL"
  head -5 "$JSONL" | python3 -c "
  import json, sys
  for line in sys.stdin:
      try:
          d = json.loads(line)
          print('Keys:', sorted(d.keys()))
          if 'type' in d: print('  type:', d['type'])
      except: pass
  "
  ```

- [ ] **Step 3: Determine the cwd→directory encoding**

  ```bash
  ls ~/.claude/projects/ | head -3
  # The encoding is typically `-` separator (e.g. `-home-jiangzhuo-Desktop-kizunaai-sesshin`).
  # Confirm by matching against your known cwds.
  ```

- [ ] **Step 4: Determine session-id-to-filename mapping**

  ```bash
  basename "$JSONL"
  # Should be <session-id>.jsonl. Confirm session-id is a UUID v4.
  ```

- [ ] **Step 5: Confirm append-only**

  ```bash
  # Tail the file while running a turn in another terminal.
  tail -f "$JSONL"
  # Verify only new lines appear; existing lines are not modified.
  ```

- [ ] **Step 6: Append findings to validation log**

  Add `## 12.2 Session JSONL format (run YYYY-MM-DD)` documenting:
  - Exact path-encoding rule for cwd
  - Filename format (`<sessionId>.jsonl` confirmed?)
  - Top-level fields seen on each line type
  - Append-only behavior confirmed

- [ ] **Step 7: Commit**

  ```bash
  git add docs/validation-log.md
  git commit -m "validation: gate 2 session JSONL format result"
  ```

### Task 3: Verification gate 3 — Hook event JSON shapes

**Files:**
- Create: `/tmp/sesshin-gate3-capture.sh` (transient)
- Modify: `docs/validation-log.md` (append "## 12.3 Hook event JSON shapes")

- [ ] **Step 1: Write a capture hook script**

  ```bash
  cat > /tmp/sesshin-gate3-capture.sh <<'EOF'
  #!/bin/sh
  # Read stdin (event JSON), append to capture log with the event type.
  # Always exit 0 so claude isn't disrupted.
  EVENT_NAME="${1:-unknown}"
  cat - >> /tmp/sesshin-gate3-events.jsonl
  echo "" >> /tmp/sesshin-gate3-events.jsonl
  EOF
  chmod +x /tmp/sesshin-gate3-capture.sh
  rm -f /tmp/sesshin-gate3-events.jsonl
  ```

- [ ] **Step 2: Write a settings file that pipes every hook to the capture script**

  ```bash
  cat > /tmp/sesshin-gate3-settings.json <<'EOF'
  {
    "hooks": {
      "SessionStart":     [{ "matcher":"*", "hooks":[{ "type":"command", "command":"/tmp/sesshin-gate3-capture.sh SessionStart" }]}],
      "UserPromptSubmit": [{ "matcher":"*", "hooks":[{ "type":"command", "command":"/tmp/sesshin-gate3-capture.sh UserPromptSubmit" }]}],
      "PreToolUse":       [{ "matcher":"*", "hooks":[{ "type":"command", "command":"/tmp/sesshin-gate3-capture.sh PreToolUse" }]}],
      "PostToolUse":      [{ "matcher":"*", "hooks":[{ "type":"command", "command":"/tmp/sesshin-gate3-capture.sh PostToolUse" }]}],
      "Stop":             [{ "matcher":"*", "hooks":[{ "type":"command", "command":"/tmp/sesshin-gate3-capture.sh Stop" }]}],
      "StopFailure":      [{ "matcher":"*", "hooks":[{ "type":"command", "command":"/tmp/sesshin-gate3-capture.sh StopFailure" }]}],
      "SessionEnd":       [{ "matcher":"*", "hooks":[{ "type":"command", "command":"/tmp/sesshin-gate3-capture.sh SessionEnd" }]}]
    }
  }
  EOF
  ```

- [ ] **Step 3: Run a real claude session that exercises all event types**

  ```bash
  cd /tmp
  claude --settings /tmp/sesshin-gate3-settings.json -p 'list the current directory then exit'
  ```

  This should produce SessionStart → UserPromptSubmit → PreToolUse → PostToolUse → Stop → SessionEnd.

- [ ] **Step 4: Inspect the captured events**

  ```bash
  python3 -c "
  import json
  for i, line in enumerate(open('/tmp/sesshin-gate3-events.jsonl')):
      line = line.strip()
      if not line: continue
      try:
          d = json.loads(line)
          # Print top-level keys per event without leaking values
          shape = {k: type(v).__name__ for k, v in d.items()}
          print(f'Event {i}: hook_event_name={d.get(\"hook_event_name\", d.get(\"event\", \"?\"))} keys={sorted(shape.keys())}')
      except Exception as e:
          print(f'Event {i}: parse error: {e}')
  "
  ```

- [ ] **Step 5: Append findings to validation log**

  Document the EXACT JSON-key set for each of the seven hook event types as observed. These will inform the zod schemas in T7 (shared/protocol).

- [ ] **Step 6: Cleanup and commit**

  ```bash
  rm -f /tmp/sesshin-gate3-capture.sh /tmp/sesshin-gate3-settings.json /tmp/sesshin-gate3-events.jsonl
  git add docs/validation-log.md
  git commit -m "validation: gate 3 hook event JSON shapes"
  ```

### Task 4: Verification gate 4 — PTY input injection sanity

**Files:**
- Modify: `docs/validation-log.md` (append "## 12.4 PTY input injection")

- [ ] **Step 1: Install node-pty for the probe**

  ```bash
  cd /tmp
  npm init -y
  npm install --save node-pty@latest
  ```

- [ ] **Step 2: Write a small probe script**

  ```bash
  cat > /tmp/gate4-probe.mjs <<'EOF'
  import pty from 'node-pty';
  const p = pty.spawn('claude', ['-p', 'reply with the word "GO" then await my confirmation: do you confirm? type y or n.'], {
    name: 'xterm-256color', cols: 100, rows: 30, cwd: '/tmp', env: process.env
  });
  let buf = '';
  p.onData(d => { buf += d; process.stdout.write(d); });
  p.onExit(({ exitCode }) => { console.error(`\n[probe] exit=${exitCode}, total stdout bytes=${buf.length}`); });
  // Wait briefly, then inject a "y"
  setTimeout(() => { p.write('y\n'); }, 5000);
  EOF
  ```

- [ ] **Step 3: Run the probe**

  ```bash
  cd /tmp
  node gate4-probe.mjs
  ```

  Observe:
  - Does claude print "GO"?
  - After ~5s, does the injected "y\n" appear and does claude react to it as confirmation?
  - Does the process exit cleanly?

- [ ] **Step 4: Document outcome**

  Append `## 12.4 PTY input injection (run YYYY-MM-DD)` to `docs/validation-log.md` with:
  - Whether the injected `y\n` was treated identically to a typed key
  - Any timing or echo issues observed
  - Note: even if it works at the probe level, integration in the real CLI may need raw-mode + bracketed-paste handling (deferred to T52)

- [ ] **Step 5: Cleanup and commit**

  ```bash
  rm -rf /tmp/gate4-probe.mjs /tmp/package.json /tmp/package-lock.json /tmp/node_modules
  git add docs/validation-log.md
  git commit -m "validation: gate 4 PTY input injection result"
  ```

### Task 5: Workspace scaffold (pnpm + base TS config)

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.nvmrc`
- Modify: `.gitignore`

- [ ] **Step 1: Create root `package.json`**

  ```json
  {
    "name": "sesshin",
    "private": true,
    "version": "0.0.0",
    "type": "module",
    "engines": { "node": ">=22" },
    "packageManager": "pnpm@9.0.0",
    "scripts": {
      "build": "pnpm -r build",
      "test": "pnpm -r test",
      "test:watch": "pnpm -r --parallel test:watch",
      "dev": "pnpm -r --parallel dev",
      "clean": "pnpm -r exec rm -rf dist node_modules/.cache"
    },
    "devDependencies": {
      "typescript": "^5.6.0"
    }
  }
  ```

- [ ] **Step 2: Create `pnpm-workspace.yaml`**

  ```yaml
  packages:
    - 'packages/*'
  ```

- [ ] **Step 3: Create `tsconfig.base.json`**

  ```json
  {
    "compilerOptions": {
      "target": "ES2023",
      "module": "ESNext",
      "moduleResolution": "Bundler",
      "lib": ["ES2023", "DOM"],
      "strict": true,
      "noUncheckedIndexedAccess": true,
      "exactOptionalPropertyTypes": true,
      "esModuleInterop": true,
      "isolatedModules": true,
      "verbatimModuleSyntax": true,
      "skipLibCheck": true,
      "resolveJsonModule": true,
      "declaration": true,
      "declarationMap": true,
      "sourceMap": true
    }
  }
  ```

- [ ] **Step 4: Create `.nvmrc`**

  ```
  22
  ```

- [ ] **Step 5: Update `.gitignore`**

  Append to `.gitignore`:
  ```
  packages/*/dist/
  packages/*/node_modules/
  packages/*/.tsbuildinfo
  packages/*/coverage/
  ```

- [ ] **Step 6: Initialize pnpm**

  ```bash
  pnpm install
  ```

  Expected: pnpm creates `pnpm-lock.yaml` and `node_modules/`. No errors.

- [ ] **Step 7: Commit M0 milestone**

  ```bash
  git add package.json pnpm-workspace.yaml tsconfig.base.json .nvmrc .gitignore pnpm-lock.yaml
  git commit -m "scaffold: pnpm workspace + base TS config"
  ```

---

## Milestone M1: `@sesshin/shared`

Pure types and schemas. No I/O. Browser-safe.

### Task 6: shared package skeleton

**Files:**
- Create: `packages/shared/{package.json,tsconfig.json,tsup.config.ts,vitest.config.ts,src/index.ts}`

- [ ] **Step 1: Create `packages/shared/package.json`**

  ```json
  {
    "name": "@sesshin/shared",
    "version": "0.0.0",
    "type": "module",
    "private": true,
    "exports": {
      ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" },
      "./crypto": { "import": "./dist/crypto.js", "types": "./dist/crypto.d.ts" },
      "./protocol": { "import": "./dist/protocol.js", "types": "./dist/protocol.d.ts" }
    },
    "scripts": {
      "build": "tsup",
      "dev": "tsup --watch",
      "test": "vitest run",
      "test:watch": "vitest"
    },
    "dependencies": {
      "zod": "^3.23.0",
      "tweetnacl": "^1.0.3",
      "tweetnacl-util": "^0.15.1"
    },
    "devDependencies": {
      "tsup": "^8.3.0",
      "vitest": "^2.1.0"
    }
  }
  ```

- [ ] **Step 2: Create `packages/shared/tsconfig.json`**

  ```json
  {
    "extends": "../../tsconfig.base.json",
    "compilerOptions": {
      "outDir": "dist",
      "rootDir": "src"
    },
    "include": ["src/**/*"]
  }
  ```

- [ ] **Step 3: Create `packages/shared/tsup.config.ts`**

  ```typescript
  import { defineConfig } from 'tsup';
  export default defineConfig({
    entry: ['src/index.ts', 'src/crypto.ts', 'src/protocol.ts'],
    format: ['esm'],
    dts: true,
    clean: true,
    sourcemap: true,
  });
  ```

- [ ] **Step 4: Create `packages/shared/vitest.config.ts`**

  ```typescript
  import { defineConfig } from 'vitest/config';
  export default defineConfig({
    test: { globals: false, coverage: { provider: 'v8' } }
  });
  ```

- [ ] **Step 5: Create empty barrel `packages/shared/src/index.ts`**

  ```typescript
  export {};
  ```

- [ ] **Step 6: Install deps and verify build**

  ```bash
  cd packages/shared && pnpm install && pnpm build
  ```

  Expected: `dist/index.js` exists; no TypeScript errors.

- [ ] **Step 7: Commit**

  ```bash
  git add packages/shared/ pnpm-lock.yaml
  git commit -m "shared: package skeleton (tsup + vitest)"
  ```

### Task 7: Crypto helpers (NaCl secretbox)

**Files:**
- Create: `packages/shared/src/crypto.ts`, `packages/shared/src/crypto.test.ts`

- [ ] **Step 1: Write the failing test `packages/shared/src/crypto.test.ts`**

  ```typescript
  import { describe, it, expect } from 'vitest';
  import { deriveKey, encrypt, decrypt } from './crypto.js';

  describe('crypto', () => {
    it('derives a 32-byte key deterministically from a token', () => {
      const a = deriveKey('hello');
      const b = deriveKey('hello');
      expect(a).toEqual(b);
      expect(a.length).toBe(32);
      expect(deriveKey('world')).not.toEqual(a);
    });

    it('encrypts and decrypts a string roundtrip', () => {
      const key = deriveKey('session-token-abc');
      const cipher = encrypt('hello world', key);
      expect(typeof cipher).toBe('string');
      expect(cipher).not.toBe('hello world');
      expect(decrypt(cipher, key)).toBe('hello world');
    });

    it('rejects tampered ciphertext', () => {
      const key = deriveKey('k');
      const cipher = encrypt('hi', key);
      // Flip the last char
      const tampered = cipher.slice(0, -1) + (cipher.at(-1) === 'A' ? 'B' : 'A');
      expect(() => decrypt(tampered, key)).toThrow();
    });

    it('rejects decryption with the wrong key', () => {
      const cipher = encrypt('hi', deriveKey('k1'));
      expect(() => decrypt(cipher, deriveKey('k2'))).toThrow();
    });
  });
  ```

- [ ] **Step 2: Run, expect failure**

  ```bash
  cd packages/shared && pnpm test
  ```

  Expected: tests fail because `./crypto.js` doesn't exist.

- [ ] **Step 3: Implement `packages/shared/src/crypto.ts`**

  ```typescript
  import nacl from 'tweetnacl';
  import { decodeBase64, encodeBase64, decodeUTF8, encodeUTF8 } from 'tweetnacl-util';

  /** Derive a 32-byte symmetric key from a token via SHA-512 truncation. */
  export function deriveKey(token: string): Uint8Array {
    const tokenBytes = decodeUTF8(token);
    const hash = nacl.hash(tokenBytes); // 64 bytes (SHA-512)
    return hash.slice(0, 32);
  }

  /** Encrypt UTF-8 string, return base64(nonce || ciphertext). */
  export function encrypt(plaintext: string, key: Uint8Array): string {
    if (key.length !== 32) throw new Error('key must be 32 bytes');
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    const message = decodeUTF8(plaintext);
    const box = nacl.secretbox(message, nonce, key);
    const out = new Uint8Array(nonce.length + box.length);
    out.set(nonce, 0);
    out.set(box, nonce.length);
    return encodeBase64(out);
  }

  /** Decrypt base64(nonce || ciphertext), throw on tamper or wrong key. */
  export function decrypt(b64: string, key: Uint8Array): string {
    if (key.length !== 32) throw new Error('key must be 32 bytes');
    const buf = decodeBase64(b64);
    const nonce = buf.slice(0, nacl.secretbox.nonceLength);
    const box = buf.slice(nacl.secretbox.nonceLength);
    const message = nacl.secretbox.open(box, nonce, key);
    if (!message) throw new Error('decryption failed');
    return encodeUTF8(message);
  }
  ```

- [ ] **Step 4: Run, expect pass**

  ```bash
  pnpm test
  ```

  Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/shared/src/crypto.ts packages/shared/src/crypto.test.ts
  git commit -m "shared: NaCl secretbox crypto helpers (deriveKey, encrypt, decrypt)"
  ```

### Task 8: Action enum and session/state types

**Files:**
- Create: `packages/shared/src/actions.ts`, `packages/shared/src/session.ts`, `packages/shared/src/session.test.ts`

- [ ] **Step 1: Create `packages/shared/src/actions.ts`**

  ```typescript
  import { z } from 'zod';

  export const ActionEnum = z.enum([
    'continue', 'stop', 'retry', 'fix', 'summarize',
    'details', 'ignore', 'snooze', 'approve', 'reject'
  ]);
  export type Action = z.infer<typeof ActionEnum>;
  ```

- [ ] **Step 2: Create `packages/shared/src/session.ts`**

  ```typescript
  import { z } from 'zod';

  export const SessionStateEnum = z.enum([
    'starting', 'idle', 'running',
    'awaiting-input', 'awaiting-confirmation',
    'error', 'done', 'interrupted'
  ]);
  export type SessionState = z.infer<typeof SessionStateEnum>;

  export const ConnectivityEnum = z.enum(['ok', 'degraded', 'offline']);

  export const SubstateSchema = z.object({
    currentTool:           z.string().nullable(),
    lastTool:              z.string().nullable(),
    lastFileTouched:       z.string().nullable(),
    lastCommandRun:        z.string().nullable(),
    elapsedSinceProgressMs: z.number().int().nonnegative(),
    tokensUsedTurn:        z.number().int().nullable(),
    connectivity:          ConnectivityEnum,
    stalled:               z.boolean(),
  });
  export type Substate = z.infer<typeof SubstateSchema>;

  export const AgentEnum = z.enum(['claude-code', 'codex', 'gemini', 'other']);

  export const SessionInfoSchema = z.object({
    id:             z.string(),
    name:           z.string(),
    agent:          AgentEnum,
    cwd:            z.string(),
    pid:            z.number().int(),
    startedAt:      z.number().int(),
    state:          SessionStateEnum,
    substate:       SubstateSchema,
    lastSummaryId:  z.string().nullable(),
  });
  export type SessionInfo = z.infer<typeof SessionInfoSchema>;
  ```

- [ ] **Step 3: Write `packages/shared/src/session.test.ts`**

  ```typescript
  import { describe, it, expect } from 'vitest';
  import { SessionInfoSchema, SessionStateEnum, SubstateSchema } from './session.js';
  import { ActionEnum } from './actions.js';

  describe('session schemas', () => {
    it('SessionStateEnum accepts the 8 documented states', () => {
      for (const s of ['starting','idle','running','awaiting-input','awaiting-confirmation','error','done','interrupted']) {
        expect(SessionStateEnum.parse(s)).toBe(s);
      }
      expect(() => SessionStateEnum.parse('paused')).toThrow();
    });
    it('Substate roundtrips', () => {
      const s = {
        currentTool: null, lastTool: 'Edit', lastFileTouched: '/x',
        lastCommandRun: null, elapsedSinceProgressMs: 0,
        tokensUsedTurn: null, connectivity: 'ok', stalled: false,
      };
      expect(SubstateSchema.parse(s)).toEqual(s);
    });
    it('SessionInfo requires all fields', () => {
      expect(() => SessionInfoSchema.parse({ id: 'x' })).toThrow();
    });
  });
  describe('actions', () => {
    it('accepts the 10 reserved action names', () => {
      for (const a of ['continue','stop','retry','fix','summarize','details','ignore','snooze','approve','reject']) {
        expect(ActionEnum.parse(a)).toBe(a);
      }
      expect(() => ActionEnum.parse('detonate')).toThrow();
    });
  });
  ```

- [ ] **Step 4: Run, expect pass**

  ```bash
  pnpm test
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add packages/shared/src/actions.ts packages/shared/src/session.ts packages/shared/src/session.test.ts
  git commit -m "shared: SessionState, Substate, SessionInfo, Action schemas"
  ```

### Task 9: Hook event vocabulary and Claude-specific mapping

**Files:**
- Create: `packages/shared/src/hook-events.ts`, `packages/shared/src/hook-events.test.ts`

- [ ] **Step 1: Create `packages/shared/src/hook-events.ts`**

  ```typescript
  import { z } from 'zod';

  /** Sesshin's normalized event vocabulary, agent-agnostic. */
  export const NormalizedHookEventEnum = z.enum([
    'SessionStart', 'UserPromptSubmit',
    'PreToolUse', 'PostToolUse',
    'Stop', 'StopFailure', 'SessionEnd',
    'agent-internal',
  ]);
  export type NormalizedHookEvent = z.infer<typeof NormalizedHookEventEnum>;

  /** Per-agent native → normalized mapping. */
  export const ClaudeHookMap: Record<string, NormalizedHookEvent> = {
    SessionStart: 'SessionStart',
    UserPromptSubmit: 'UserPromptSubmit',
    PreToolUse: 'PreToolUse',
    PostToolUse: 'PostToolUse',
    Stop: 'Stop',
    StopFailure: 'StopFailure',
    SessionEnd: 'SessionEnd',
  };

  export function normalizeClaudeEvent(native: string): NormalizedHookEvent {
    const mapped = ClaudeHookMap[native];
    return mapped ?? 'agent-internal';
  }
  ```

- [ ] **Step 2: Write `packages/shared/src/hook-events.test.ts`**

  ```typescript
  import { describe, it, expect } from 'vitest';
  import { normalizeClaudeEvent, NormalizedHookEventEnum } from './hook-events.js';

  describe('hook-events', () => {
    it('maps every documented Claude hook event to the same normalized name', () => {
      for (const name of ['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','Stop','StopFailure','SessionEnd']) {
        expect(normalizeClaudeEvent(name)).toBe(name);
      }
    });
    it('passes through unknown events as agent-internal', () => {
      expect(normalizeClaudeEvent('SomeFutureEvent')).toBe('agent-internal');
    });
    it('NormalizedHookEventEnum rejects invalid', () => {
      expect(() => NormalizedHookEventEnum.parse('Bogus')).toThrow();
    });
  });
  ```

- [ ] **Step 3: Run, expect pass**

  ```bash
  pnpm test
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add packages/shared/src/hook-events.ts packages/shared/src/hook-events.test.ts
  git commit -m "shared: normalized hook event vocabulary + Claude mapping"
  ```

### Task 10: Summary, Event, and protocol message schemas

**Files:**
- Create: `packages/shared/src/summary.ts`, `packages/shared/src/events.ts`, `packages/shared/src/protocol.ts`, `packages/shared/src/protocol.test.ts`

- [ ] **Step 1: Create `packages/shared/src/summary.ts`**

  ```typescript
  import { z } from 'zod';
  export const SummarySchema = z.object({
    summaryId:      z.string(),
    oneLine:        z.string().max(100),
    bullets:        z.array(z.string().max(80)).max(5),
    needsDecision:  z.boolean(),
    suggestedNext:  z.string().nullable(),
    since:          z.string().nullable(),
    generatedAt:    z.number().int(),
    generatorModel: z.string(),
  });
  export type Summary = z.infer<typeof SummarySchema>;
  ```

- [ ] **Step 2: Create `packages/shared/src/events.ts`**

  ```typescript
  import { z } from 'zod';
  import { NormalizedHookEventEnum } from './hook-events.js';

  export const EventKindEnum = z.enum([
    'user-prompt', 'tool-call', 'tool-result',
    'agent-output', 'error', 'stall', 'agent-internal',
  ]);
  export type EventKind = z.infer<typeof EventKindEnum>;

  export const EventSourceSchema = z.union([
    z.literal('laptop'),
    z.string().regex(/^remote-adapter:[a-z0-9-]+$/i),
    z.string().regex(/^observer:(hook-ingest|session-file-tail|pty-tap)$/),
  ]);

  export const EventSchema = z.object({
    type:      z.literal('session.event'),
    sessionId: z.string(),
    eventId:   z.string(),
    kind:      EventKindEnum,
    nativeEvent: NormalizedHookEventEnum.optional(),
    payload:   z.record(z.string(), z.unknown()),
    source:    EventSourceSchema,
    ts:        z.number().int(),
  });
  export type Event = z.infer<typeof EventSchema>;
  ```

- [ ] **Step 3: Create `packages/shared/src/protocol.ts`**

  ```typescript
  import { z } from 'zod';
  import { SessionInfoSchema, SessionStateEnum, SubstateSchema } from './session.js';
  import { SummarySchema } from './summary.js';
  import { EventSchema } from './events.js';
  import { ActionEnum } from './actions.js';

  export const PROTOCOL_VERSION = 1 as const;

  export const ClientKindEnum = z.enum(['debug-web','telegram-adapter','m5stick','watch','mobile','other']);
  export const CapabilityEnum = z.enum(['summary','events','raw','actions','voice','history','state','attention']);

  // ---- Upstream (client → hub) ----
  export const ClientIdentifySchema = z.object({
    type:     z.literal('client.identify'),
    protocol: z.literal(PROTOCOL_VERSION),
    client:   z.object({
      kind:         ClientKindEnum,
      version:      z.string(),
      capabilities: z.array(CapabilityEnum),
    }),
  });
  export const SubscribeSchema = z.object({
    type:     z.literal('subscribe'),
    sessions: z.union([z.array(z.string()), z.literal('all')]),
    since:    z.string().nullable(),
  });
  export const UnsubscribeSchema = z.object({
    type:     z.literal('unsubscribe'),
    sessions: z.array(z.string()),
  });
  export const InputTextSchema = z.object({
    type:      z.literal('input.text'),
    sessionId: z.string(),
    text:      z.string(),
  });
  export const InputActionSchema = z.object({
    type:      z.literal('input.action'),
    sessionId: z.string(),
    action:    ActionEnum,
  });
  export const ClientPongSchema = z.object({
    type:  z.literal('client.pong'),
    nonce: z.string(),
  });

  export const UpstreamMessageSchema = z.discriminatedUnion('type', [
    ClientIdentifySchema, SubscribeSchema, UnsubscribeSchema,
    InputTextSchema, InputActionSchema, ClientPongSchema,
  ]);
  export type UpstreamMessage = z.infer<typeof UpstreamMessageSchema>;

  // ---- Downstream (hub → client) ----
  export const ServerHelloSchema = z.object({
    type:      z.literal('server.hello'),
    protocol:  z.literal(PROTOCOL_VERSION),
    machine:   z.string(),
    supported: z.array(CapabilityEnum),
  });
  export const SessionListSchema = z.object({
    type:     z.literal('session.list'),
    sessions: z.array(SessionInfoSchema),
  });
  export const SessionAddedSchema = z.object({
    type:    z.literal('session.added'),
    session: SessionInfoSchema,
  });
  export const SessionRemovedSchema = z.object({
    type:      z.literal('session.removed'),
    sessionId: z.string(),
  });
  export const SessionStateMsgSchema = z.object({
    type:      z.literal('session.state'),
    sessionId: z.string(),
    state:     SessionStateEnum,
    substate:  SubstateSchema,
  });
  export const SessionEventMsgSchema = EventSchema; // type: "session.event"
  export const SessionSummaryMsgSchema = z.object({
    type:      z.literal('session.summary'),
    sessionId: z.string(),
  }).and(SummarySchema);
  export const SessionAttentionSchema = z.object({
    type:       z.literal('session.attention'),
    sessionId:  z.string(),
    severity:   z.enum(['info','warning','error']),
    reason:     z.string(),
    summaryId:  z.string().optional(),
  });
  export const SessionRawSchema = z.object({
    type:      z.literal('session.raw'),
    sessionId: z.string(),
    seq:       z.number().int(),
    data:      z.string(),
  });
  export const ServerErrorSchema = z.object({
    type:    z.literal('server.error'),
    code:    z.string(),
    message: z.string().optional(),
  });
  export const ServerPingSchema = z.object({
    type:  z.literal('server.ping'),
    nonce: z.string(),
  });

  export const DownstreamMessageSchema = z.discriminatedUnion('type', [
    ServerHelloSchema, SessionListSchema, SessionAddedSchema, SessionRemovedSchema,
    SessionStateMsgSchema, SessionEventMsgSchema, SessionSummaryMsgSchema,
    SessionAttentionSchema, SessionRawSchema, ServerErrorSchema, ServerPingSchema,
  ]);
  export type DownstreamMessage = z.infer<typeof DownstreamMessageSchema>;
  ```

- [ ] **Step 4: Update `packages/shared/src/index.ts` to re-export everything**

  ```typescript
  export * from './actions.js';
  export * from './session.js';
  export * from './summary.js';
  export * from './events.js';
  export * from './hook-events.js';
  export * from './protocol.js';
  ```

- [ ] **Step 5: Write `packages/shared/src/protocol.test.ts`**

  ```typescript
  import { describe, it, expect } from 'vitest';
  import {
    ClientIdentifySchema, SubscribeSchema, InputActionSchema,
    UpstreamMessageSchema, DownstreamMessageSchema,
    SessionListSchema, ServerErrorSchema, PROTOCOL_VERSION,
  } from './protocol.js';

  describe('protocol upstream', () => {
    it('round-trips client.identify', () => {
      const msg = {
        type: 'client.identify' as const,
        protocol: PROTOCOL_VERSION,
        client: { kind: 'debug-web' as const, version: '0.0.0', capabilities: ['summary' as const] },
      };
      expect(UpstreamMessageSchema.parse(msg)).toEqual(msg);
    });
    it('rejects unknown upstream type', () => {
      expect(() => UpstreamMessageSchema.parse({ type: 'nonsense' })).toThrow();
    });
    it('subscribe accepts "all"', () => {
      expect(SubscribeSchema.parse({ type: 'subscribe', sessions: 'all', since: null })).toBeTruthy();
    });
    it('input.action rejects unknown action', () => {
      expect(() => InputActionSchema.parse({ type: 'input.action', sessionId: 's', action: 'detonate' })).toThrow();
    });
  });
  describe('protocol downstream', () => {
    it('parses session.list with empty array', () => {
      expect(SessionListSchema.parse({ type: 'session.list', sessions: [] })).toBeTruthy();
    });
    it('server.error allows omitted message', () => {
      expect(ServerErrorSchema.parse({ type: 'server.error', code: 'bad-frame' })).toBeTruthy();
    });
  });
  ```

- [ ] **Step 6: Run, expect pass**

  ```bash
  pnpm test
  ```

- [ ] **Step 7: Verify build still works**

  ```bash
  pnpm build
  ls dist/
  ```

  Expected: `index.js`, `crypto.js`, `protocol.js` and their `.d.ts` siblings.

- [ ] **Step 8: Commit**

  ```bash
  git add packages/shared/src/
  git commit -m "shared: Summary, Event, full WS protocol message schemas"
  ```

### Task 11: M1 milestone checkpoint

- [ ] **Step 1: Run all shared tests**

  ```bash
  cd /home/jiangzhuo/Desktop/kizunaai/sesshin
  pnpm test --filter @sesshin/shared
  ```

  Expected: all crypto, session, hook-events, protocol tests pass.

- [ ] **Step 2: Build all packages (only shared exists)**

  ```bash
  pnpm build
  ```

  Expected: clean build.

- [ ] **Step 3: Commit checkpoint tag (no actual code change)**

  ```bash
  git tag M1
  ```

---

## Milestone M2: `@sesshin/hook-handler`

A small standalone binary. No hub yet — tests use a fake server.

### Task 12: hook-handler package skeleton + main flow

**Files:**
- Create: `packages/hook-handler/{package.json,tsconfig.json,tsup.config.ts,vitest.config.ts,src/main.ts,src/normalize.ts,bin/sesshin-hook-handler}`

- [ ] **Step 1: `packages/hook-handler/package.json`**

  ```json
  {
    "name": "@sesshin/hook-handler",
    "version": "0.0.0",
    "type": "module",
    "private": true,
    "bin": { "sesshin-hook-handler": "bin/sesshin-hook-handler" },
    "scripts": {
      "build": "tsup",
      "dev": "tsup --watch",
      "test": "vitest run",
      "test:watch": "vitest"
    },
    "dependencies": { "@sesshin/shared": "workspace:*" },
    "devDependencies": { "tsup": "^8.3.0", "vitest": "^2.1.0", "@types/node": "^22.0.0" }
  }
  ```

- [ ] **Step 2: `packages/hook-handler/tsconfig.json`**

  ```json
  {
    "extends": "../../tsconfig.base.json",
    "compilerOptions": { "outDir": "dist", "rootDir": "src", "lib": ["ES2023"] },
    "include": ["src/**/*"]
  }
  ```

- [ ] **Step 3: `packages/hook-handler/tsup.config.ts`**

  ```typescript
  import { defineConfig } from 'tsup';
  export default defineConfig({
    entry: ['src/main.ts'],
    format: ['esm'],
    target: 'node22',
    clean: true,
    sourcemap: true,
  });
  ```

- [ ] **Step 4: `packages/hook-handler/vitest.config.ts`**

  ```typescript
  import { defineConfig } from 'vitest/config';
  export default defineConfig({ test: { coverage: { provider: 'v8' } } });
  ```

- [ ] **Step 5: `packages/hook-handler/bin/sesshin-hook-handler`**

  ```sh
  #!/usr/bin/env node
  import('../dist/main.js');
  ```

  Then `chmod +x packages/hook-handler/bin/sesshin-hook-handler`.

- [ ] **Step 6: `packages/hook-handler/src/normalize.ts`**

  ```typescript
  import { normalizeClaudeEvent, type NormalizedHookEvent } from '@sesshin/shared';

  export function normalize(agent: string, nativeEvent: string): NormalizedHookEvent {
    if (agent === 'claude-code') return normalizeClaudeEvent(nativeEvent);
    return 'agent-internal';
  }
  ```

- [ ] **Step 7: `packages/hook-handler/src/main.ts`**

  ```typescript
  import { normalize } from './normalize.js';

  const TIMEOUT_MS = 250;

  async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf-8');
  }

  async function main(): Promise<void> {
    const agent = process.env['SESSHIN_AGENT'] ?? 'claude-code';
    const sessionId = process.env['SESSHIN_SESSION_ID'] ?? '';
    const hubUrl = process.env['SESSHIN_HUB_URL'] ?? 'http://127.0.0.1:9663';
    const nativeEvent = process.argv[2] ?? 'unknown';

    const raw = await readStdin();
    let parsed: unknown = null;
    try { parsed = raw.length > 0 ? JSON.parse(raw) : null; } catch { /* keep null */ }

    const body = {
      agent,
      sessionId,
      ts: Date.now(),
      event: normalize(agent, nativeEvent),
      raw: { nativeEvent, ...(parsed && typeof parsed === 'object' ? parsed : {}) },
    };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      await fetch(`${hubUrl}/hooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch {
      // Hub unreachable / timeout / network error — drop silently.
    } finally {
      clearTimeout(timer);
    }
  }

  // ALWAYS exit 0. A non-zero exit could abort the user's claude turn.
  main()
    .then(() => process.exit(0))
    .catch(() => process.exit(0));
  ```

- [ ] **Step 8: Install + build**

  ```bash
  pnpm install
  cd packages/hook-handler && pnpm build
  ```

- [ ] **Step 9: Commit**

  ```bash
  git add packages/hook-handler/ pnpm-lock.yaml
  git commit -m "hook-handler: package skeleton + main flow (stdin → POST, 250ms timeout)"
  ```

### Task 13: hook-handler tests (timeout, exit-0 invariant, normalization)

**Files:**
- Create: `packages/hook-handler/src/main.test.ts`, `packages/hook-handler/src/normalize.test.ts`

- [ ] **Step 1: `packages/hook-handler/src/normalize.test.ts`**

  ```typescript
  import { describe, it, expect } from 'vitest';
  import { normalize } from './normalize.js';

  describe('normalize', () => {
    it('passes Claude events through', () => {
      expect(normalize('claude-code', 'Stop')).toBe('Stop');
      expect(normalize('claude-code', 'PreToolUse')).toBe('PreToolUse');
    });
    it('falls back to agent-internal for unknown agent', () => {
      expect(normalize('codex', 'Stop')).toBe('agent-internal');
    });
  });
  ```

- [ ] **Step 2: `packages/hook-handler/src/main.test.ts`**

  ```typescript
  import { describe, it, expect } from 'vitest';
  import { spawn } from 'node:child_process';
  import { createServer } from 'node:http';
  import { fileURLToPath } from 'node:url';
  import { dirname, join } from 'node:path';

  const HERE = dirname(fileURLToPath(import.meta.url));
  const HANDLER = join(HERE, '../dist/main.js');

  function startFakeHub(opts: { delayMs?: number; respondStatus?: number } = {}) {
    return new Promise<{ port: number; received: any[]; close: () => void }>((resolve) => {
      const received: any[] = [];
      const server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        try { received.push(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); } catch { /* */ }
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        res.writeHead(opts.respondStatus ?? 200);
        res.end();
      });
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as any).port;
        resolve({ port, received, close: () => server.close() });
      });
    });
  }

  function runHandler(args: { hubUrl: string; sessionId: string; nativeEvent: string; stdin: string }) {
    return new Promise<{ code: number; durationMs: number; stdout: string; stderr: string }>((resolve) => {
      const t0 = Date.now();
      const child = spawn(process.execPath, [HANDLER, args.nativeEvent], {
        env: {
          ...process.env,
          SESSHIN_HUB_URL: args.hubUrl,
          SESSHIN_SESSION_ID: args.sessionId,
          SESSHIN_AGENT: 'claude-code',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.stdin.end(args.stdin);
      child.on('exit', (code) => resolve({ code: code ?? 0, durationMs: Date.now() - t0, stdout, stderr }));
    });
  }

  describe('hook-handler binary', () => {
    it('POSTs the event JSON to the hub', async () => {
      const hub = await startFakeHub();
      const r = await runHandler({
        hubUrl: `http://127.0.0.1:${hub.port}`,
        sessionId: 'sid-test',
        nativeEvent: 'Stop',
        stdin: JSON.stringify({ session_id: 'cc-uuid-1' }),
      });
      hub.close();
      expect(r.code).toBe(0);
      expect(hub.received).toHaveLength(1);
      expect(hub.received[0]).toMatchObject({
        agent: 'claude-code',
        sessionId: 'sid-test',
        event: 'Stop',
        raw: { nativeEvent: 'Stop', session_id: 'cc-uuid-1' },
      });
    });

    it('exits 0 within 350ms even when hub is slow (250ms timeout)', async () => {
      const hub = await startFakeHub({ delayMs: 5000 });
      const r = await runHandler({
        hubUrl: `http://127.0.0.1:${hub.port}`,
        sessionId: 's', nativeEvent: 'Stop', stdin: '{}',
      });
      hub.close();
      expect(r.code).toBe(0);
      expect(r.durationMs).toBeLessThan(800); // generous cushion above 250ms
    });

    it('exits 0 even when hub returns 500', async () => {
      const hub = await startFakeHub({ respondStatus: 500 });
      const r = await runHandler({
        hubUrl: `http://127.0.0.1:${hub.port}`,
        sessionId: 's', nativeEvent: 'Stop', stdin: '{}',
      });
      hub.close();
      expect(r.code).toBe(0);
    });

    it('exits 0 when hub URL is unreachable', async () => {
      const r = await runHandler({
        hubUrl: 'http://127.0.0.1:1', sessionId: 's', nativeEvent: 'Stop', stdin: '{}',
      });
      expect(r.code).toBe(0);
    });

    it('emits empty stdout', async () => {
      const hub = await startFakeHub();
      const r = await runHandler({
        hubUrl: `http://127.0.0.1:${hub.port}`,
        sessionId: 's', nativeEvent: 'Stop', stdin: '{}',
      });
      hub.close();
      expect(r.stdout).toBe('');
    });
  });
  ```

- [ ] **Step 3: Update vitest config to depend on a build**

  Modify `packages/hook-handler/vitest.config.ts`:

  ```typescript
  import { defineConfig } from 'vitest/config';
  import { execSync } from 'node:child_process';
  export default defineConfig({
    test: {
      globalSetup: ['./vitest.setup.ts'],
      coverage: { provider: 'v8' },
      testTimeout: 10_000,
    },
  });
  ```

  Create `packages/hook-handler/vitest.setup.ts`:

  ```typescript
  import { execSync } from 'node:child_process';
  export default function setup() {
    execSync('pnpm build', { stdio: 'inherit', cwd: __dirname });
  }
  ```

  Note: `__dirname` is not available in pure ESM, so set `cwd: process.cwd()` if needed; with vitest's globalSetup the CWD is the package root.

- [ ] **Step 4: Run tests, expect pass**

  ```bash
  cd packages/hook-handler && pnpm test
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add packages/hook-handler/
  git commit -m "hook-handler: tests for POST flow, 250ms timeout, always-exit-0"
  ```

### Task 14: M2 milestone checkpoint

- [ ] **Step 1: Run full pnpm test from root**

  ```bash
  cd /home/jiangzhuo/Desktop/kizunaai/sesshin
  pnpm test
  ```

  Expected: shared + hook-handler test suites both pass.

- [ ] **Step 2: Smoke test the binary end-to-end**

  ```bash
  cd packages/hook-handler && pnpm build
  echo '{"session_id":"abc","hook_event_name":"Stop"}' | \
    SESSHIN_HUB_URL=http://127.0.0.1:1 SESSHIN_SESSION_ID=test ./bin/sesshin-hook-handler Stop
  echo "exit code: $?"
  ```

  Expected: exit code 0 (hub unreachable, but binary still exits cleanly).

- [ ] **Step 3: Tag**

  ```bash
  git tag M2
  ```

---

## Milestone M3: `@sesshin/hub` — REST surface + registry + checkpoint

Hub builds up in two milestones (M3 + M4) before WS arrives in M5.

### Task 15: hub package skeleton + entry point + config

**Files:**
- Create: `packages/hub/{package.json,tsconfig.json,tsup.config.ts,vitest.config.ts,bin/sesshin-hub,src/main.ts,src/config.ts,src/logger.ts}`

- [ ] **Step 1: `packages/hub/package.json`**

  ```json
  {
    "name": "@sesshin/hub",
    "version": "0.0.0",
    "type": "module",
    "private": true,
    "bin": { "sesshin-hub": "bin/sesshin-hub" },
    "scripts": {
      "build": "tsup",
      "dev": "tsup --watch",
      "test": "vitest run",
      "test:watch": "vitest"
    },
    "dependencies": {
      "@sesshin/shared": "workspace:*",
      "ws": "^8.18.0",
      "pino": "^9.0.0"
    },
    "devDependencies": {
      "@types/node": "^22.0.0",
      "@types/ws": "^8.5.0",
      "msw": "^2.4.0",
      "tsup": "^8.3.0",
      "vitest": "^2.1.0"
    }
  }
  ```

- [ ] **Step 2: `packages/hub/tsconfig.json`** (mirror of hook-handler).

- [ ] **Step 3: `packages/hub/tsup.config.ts`**

  ```typescript
  import { defineConfig } from 'tsup';
  export default defineConfig({
    entry: ['src/main.ts'],
    format: ['esm'], target: 'node22', clean: true, sourcemap: true,
  });
  ```

- [ ] **Step 4: `packages/hub/bin/sesshin-hub`**

  ```sh
  #!/usr/bin/env node
  import('../dist/main.js');
  ```
  Then `chmod +x`.

- [ ] **Step 5: `packages/hub/src/config.ts`**

  ```typescript
  import { homedir } from 'node:os';
  import { join } from 'node:path';

  export const config = {
    /** Loopback REST port for CLI + hook-handler ingress. */
    internalPort: Number(process.env['SESSHIN_INTERNAL_PORT'] ?? 9663),
    /** Public WS+HTTP port for adapters/browsers. */
    publicPort:   Number(process.env['SESSHIN_PUBLIC_PORT']   ?? 9662),
    /** Bind addresses for the two servers (v1: localhost only). */
    internalHost: '127.0.0.1',
    publicHost:   '127.0.0.1',
    /** Persistent state location. */
    cacheDir:     join(homedir(), '.cache', 'sesshin'),
    sessionsCheckpointFile: join(homedir(), '.cache', 'sesshin', 'sessions.json'),
    hubLogFile:   join(homedir(), '.cache', 'sesshin', 'hub.log'),
    /** Grace period after last session unregisters. */
    autoShutdownMs: 30_000,
    /** PTY raw stream ring buffer (bytes). */
    rawRingBytes: 256 * 1024,
  };
  ```

- [ ] **Step 6: `packages/hub/src/logger.ts`**

  ```typescript
  import pino from 'pino';
  import { config } from './config.js';
  import { mkdirSync, createWriteStream } from 'node:fs';
  import { dirname } from 'node:path';

  mkdirSync(dirname(config.hubLogFile), { recursive: true });
  const dest = createWriteStream(config.hubLogFile, { flags: 'a' });

  export const log = pino({ level: process.env['SESSHIN_LOG_LEVEL'] ?? 'info' }, dest);
  ```

- [ ] **Step 7: `packages/hub/src/main.ts`** (skeleton — fills in over M3-M6)

  ```typescript
  import { log } from './logger.js';
  import { config } from './config.js';

  async function main(): Promise<void> {
    log.info({ ports: { internal: config.internalPort, public: config.publicPort } }, 'sesshin-hub starting');
    // M3: REST server starts here. M5: WS server starts here.
    // For now keep the process alive so smoke testing works.
    process.on('SIGINT', () => process.exit(0));
    process.on('SIGTERM', () => process.exit(0));
    await new Promise<void>(() => { /* run forever */ });
  }
  main().catch((e) => {
    log.fatal({ err: e }, 'fatal');
    process.exit(1);
  });
  ```

- [ ] **Step 8: Install + build**

  ```bash
  pnpm install && cd packages/hub && pnpm build
  ```

- [ ] **Step 9: Commit**

  ```bash
  git add packages/hub/ pnpm-lock.yaml
  git commit -m "hub: package skeleton + config + logger"
  ```

### Task 16: SessionRegistry (in-memory)

**Files:**
- Create: `packages/hub/src/registry/session-registry.ts`, `packages/hub/src/registry/session-registry.test.ts`

- [ ] **Step 1: Write the failing test `packages/hub/src/registry/session-registry.test.ts`**

  ```typescript
  import { describe, it, expect, beforeEach } from 'vitest';
  import { SessionRegistry } from './session-registry.js';

  function makeReg() { return new SessionRegistry(); }

  describe('SessionRegistry', () => {
    it('register assigns a stable id and stores the session', () => {
      const r = makeReg();
      const s = r.register({
        id: 's1', name: 'claude (myproj)', agent: 'claude-code',
        cwd: '/home/me', pid: 1234, sessionFilePath: '/x/s1.jsonl'
      });
      expect(s.id).toBe('s1');
      expect(r.get('s1')).toMatchObject({ id: 's1', state: 'starting' });
    });
    it('unregister returns true on existing id, false on missing', () => {
      const r = makeReg();
      r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
      expect(r.unregister('s1')).toBe(true);
      expect(r.unregister('s1')).toBe(false);
    });
    it('updateState mutates and emits an event', () => {
      const r = makeReg();
      r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
      const events: string[] = [];
      r.on('state-changed', (s) => events.push(s.state));
      r.updateState('s1', 'running');
      expect(r.get('s1')?.state).toBe('running');
      expect(events).toEqual(['running']);
    });
    it('list returns a snapshot (mutations to it do not affect the registry)', () => {
      const r = makeReg();
      r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
      const snap = r.list();
      snap.length = 0;
      expect(r.list()).toHaveLength(1);
    });
  });
  ```

- [ ] **Step 2: Run, expect failure (file does not exist).**

  ```bash
  cd packages/hub && pnpm test
  ```

- [ ] **Step 3: Implement `packages/hub/src/registry/session-registry.ts`**

  ```typescript
  import { EventEmitter } from 'node:events';
  import type { SessionInfo, SessionState, Substate } from '@sesshin/shared';

  export interface RegisterInput {
    id: string;
    name: string;
    agent: SessionInfo['agent'];
    cwd: string;
    pid: number;
    sessionFilePath: string;
  }

  function defaultSubstate(): Substate {
    return {
      currentTool: null, lastTool: null, lastFileTouched: null, lastCommandRun: null,
      elapsedSinceProgressMs: 0, tokensUsedTurn: null,
      connectivity: 'ok', stalled: false,
    };
  }

  export interface RegistryEvents {
    'session-added':   (s: SessionInfo) => void;
    'session-removed': (id: string) => void;
    'state-changed':   (s: SessionInfo) => void;
    'substate-changed':(s: SessionInfo) => void;
  }

  export interface SessionRecord extends SessionInfo {
    sessionFilePath: string;
    fileTailCursor: number;
  }

  export class SessionRegistry extends EventEmitter {
    private sessions = new Map<string, SessionRecord>();

    register(input: RegisterInput): SessionRecord {
      const rec: SessionRecord = {
        id: input.id,
        name: input.name,
        agent: input.agent,
        cwd: input.cwd,
        pid: input.pid,
        startedAt: Date.now(),
        state: 'starting',
        substate: defaultSubstate(),
        lastSummaryId: null,
        sessionFilePath: input.sessionFilePath,
        fileTailCursor: 0,
      };
      this.sessions.set(rec.id, rec);
      this.emit('session-added', this.publicView(rec));
      return rec;
    }

    unregister(id: string): boolean {
      const existed = this.sessions.delete(id);
      if (existed) this.emit('session-removed', id);
      return existed;
    }

    get(id: string): SessionRecord | undefined { return this.sessions.get(id); }

    list(): SessionInfo[] { return Array.from(this.sessions.values(), this.publicView); }

    updateState(id: string, state: SessionState): void {
      const s = this.sessions.get(id);
      if (!s) return;
      if (s.state === state) return;
      s.state = state;
      this.emit('state-changed', this.publicView(s));
    }

    patchSubstate(id: string, patch: Partial<Substate>): void {
      const s = this.sessions.get(id);
      if (!s) return;
      Object.assign(s.substate, patch);
      this.emit('substate-changed', this.publicView(s));
    }

    setLastSummary(id: string, summaryId: string): void {
      const s = this.sessions.get(id);
      if (s) s.lastSummaryId = summaryId;
    }

    setFileCursor(id: string, cursor: number): void {
      const s = this.sessions.get(id);
      if (s) s.fileTailCursor = cursor;
    }

    private publicView(s: SessionRecord): SessionInfo {
      const { sessionFilePath: _f, fileTailCursor: _c, ...pub } = s;
      return pub;
    }

    override emit<K extends keyof RegistryEvents>(event: K, ...args: Parameters<RegistryEvents[K]>): boolean {
      return super.emit(event, ...args);
    }
    override on<K extends keyof RegistryEvents>(event: K, listener: RegistryEvents[K]): this {
      return super.on(event, listener as any);
    }
  }
  ```

- [ ] **Step 4: Run, expect pass.**

  ```bash
  pnpm test
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add packages/hub/src/registry/
  git commit -m "hub: SessionRegistry with state/substate + event emitter"
  ```

### Task 17: Checkpoint persistence

**Files:**
- Create: `packages/hub/src/registry/checkpoint.ts`, `packages/hub/src/registry/checkpoint.test.ts`

- [ ] **Step 1: Test `packages/hub/src/registry/checkpoint.test.ts`**

  ```typescript
  import { describe, it, expect, beforeEach, afterEach } from 'vitest';
  import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';
  import { Checkpoint } from './checkpoint.js';
  import { SessionRegistry } from './session-registry.js';

  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sesshin-cp-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function reg(): SessionRegistry {
    const r = new SessionRegistry();
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/c', pid: 1, sessionFilePath: '/p' });
    return r;
  }

  describe('Checkpoint', () => {
    it('writes to disk on registry events (debounced)', async () => {
      const r = reg();
      const cp = new Checkpoint(r, { path: join(dir, 'sess.json'), debounceMs: 10 });
      cp.start();
      r.updateState('s1', 'running');
      await new Promise((res) => setTimeout(res, 30));
      expect(existsSync(join(dir, 'sess.json'))).toBe(true);
      const data = JSON.parse(readFileSync(join(dir, 'sess.json'), 'utf-8'));
      expect(data.sessions[0]).toMatchObject({ id: 's1', state: 'running' });
      cp.stop();
    });
    it('load returns empty when no file exists', () => {
      const cp = new Checkpoint(reg(), { path: join(dir, 'absent.json'), debounceMs: 10 });
      expect(cp.load()).toEqual({ sessions: [] });
    });
  });
  ```

- [ ] **Step 2: Implement `packages/hub/src/registry/checkpoint.ts`**

  ```typescript
  import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
  import { dirname } from 'node:path';
  import type { SessionRegistry, SessionRecord } from './session-registry.js';

  interface CheckpointData { sessions: SessionRecord[] }
  interface Options { path: string; debounceMs: number }

  export class Checkpoint {
    private timer: NodeJS.Timeout | null = null;
    private dirty = false;
    private listener = () => this.markDirty();

    constructor(private readonly registry: SessionRegistry, private readonly opts: Options) {}

    start(): void {
      this.registry.on('session-added',    this.listener);
      this.registry.on('session-removed',  this.listener);
      this.registry.on('state-changed',    this.listener);
      this.registry.on('substate-changed', this.listener);
    }

    stop(): void {
      this.registry.off('session-added',    this.listener);
      this.registry.off('session-removed',  this.listener);
      this.registry.off('state-changed',    this.listener);
      this.registry.off('substate-changed', this.listener);
      if (this.timer) clearTimeout(this.timer);
      if (this.dirty) this.flushNow();
    }

    load(): CheckpointData {
      if (!existsSync(this.opts.path)) return { sessions: [] };
      try {
        return JSON.parse(readFileSync(this.opts.path, 'utf-8')) as CheckpointData;
      } catch {
        return { sessions: [] };
      }
    }

    private markDirty(): void {
      this.dirty = true;
      if (this.timer) return;
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.dirty) this.flushNow();
      }, this.opts.debounceMs);
    }

    private flushNow(): void {
      this.dirty = false;
      const records: SessionRecord[] = [];
      for (const id of (this.registry as any)['sessions'].keys()) {
        const s = this.registry.get(id);
        if (s) records.push(s);
      }
      const tmp = this.opts.path + '.tmp.' + process.pid;
      mkdirSync(dirname(this.opts.path), { recursive: true });
      writeFileSync(tmp, JSON.stringify({ sessions: records }, null, 2), { mode: 0o600 });
      renameSync(tmp, this.opts.path);
    }
  }
  ```

- [ ] **Step 3: Run, expect pass.**

  ```bash
  pnpm test
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add packages/hub/src/registry/checkpoint.ts packages/hub/src/registry/checkpoint.test.ts
  git commit -m "hub: Checkpoint with debounced atomic write"
  ```

### Task 18: REST server skeleton + /api/health

**Files:**
- Create: `packages/hub/src/rest/server.ts`, `packages/hub/src/rest/server.test.ts`

- [ ] **Step 1: Test `packages/hub/src/rest/server.test.ts`**

  ```typescript
  import { describe, it, expect, beforeEach, afterEach } from 'vitest';
  import { createRestServer, type RestServer } from './server.js';
  import { SessionRegistry } from '../registry/session-registry.js';

  let svr: RestServer;
  let port: number;
  beforeEach(async () => {
    svr = createRestServer({ registry: new SessionRegistry() });
    await svr.listen(0, '127.0.0.1');
    port = svr.address().port;
  });
  afterEach(async () => { await svr.close(); });

  describe('/api/health', () => {
    it('returns 200 with { ok: true } on GET', async () => {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: true });
    });
    it('returns 405 on non-GET', async () => {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { method: 'POST' });
      expect(r.status).toBe(405);
    });
  });
  ```

- [ ] **Step 2: Implement `packages/hub/src/rest/server.ts`**

  ```typescript
  import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
  import { AddressInfo } from 'node:net';
  import type { SessionRegistry } from '../registry/session-registry.js';

  export interface RestServerDeps { registry: SessionRegistry }

  export interface RestServer {
    listen(port: number, host: string): Promise<void>;
    close(): Promise<void>;
    address(): AddressInfo;
  }

  export function createRestServer(deps: RestServerDeps): RestServer {
    const server = createServer((req, res) => route(req, res, deps));

    return {
      listen: (port, host) => new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.off('error', reject); resolve(); });
      }),
      close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
      address: () => server.address() as AddressInfo,
    };
  }

  async function route(req: IncomingMessage, res: ServerResponse, deps: RestServerDeps): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const method = req.method ?? 'GET';
    if (url.pathname === '/api/health') return health(method, res);
    res.writeHead(404).end();
  }

  function health(method: string, res: ServerResponse): void {
    if (method !== 'GET') return void res.writeHead(405).end();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
  }
  ```

- [ ] **Step 3: Run, expect pass.**

- [ ] **Step 4: Commit**

  ```bash
  git add packages/hub/src/rest/
  git commit -m "hub: REST server skeleton + /api/health"
  ```

### Task 19: REST `/api/sessions` (POST register, DELETE unregister, GET list)

**Files:**
- Modify: `packages/hub/src/rest/server.ts`
- Create: `packages/hub/src/rest/sessions.test.ts`

- [ ] **Step 1: Test `packages/hub/src/rest/sessions.test.ts`**

  ```typescript
  import { describe, it, expect, beforeEach, afterEach } from 'vitest';
  import { createRestServer, type RestServer } from './server.js';
  import { SessionRegistry } from '../registry/session-registry.js';

  let svr: RestServer; let port: number; let registry: SessionRegistry;
  beforeEach(async () => {
    registry = new SessionRegistry();
    svr = createRestServer({ registry });
    await svr.listen(0, '127.0.0.1');
    port = svr.address().port;
  });
  afterEach(async () => { await svr.close(); });

  describe('/api/sessions', () => {
    it('POST registers and returns id', async () => {
      const body = { id: 's1', name: 'claude (x)', agent: 'claude-code', cwd: '/x', pid: 99, sessionFilePath: '/p/s1.jsonl' };
      const r = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(r.status).toBe(201);
      expect(await r.json()).toMatchObject({ id: 's1', registeredAt: expect.any(Number) });
      expect(registry.get('s1')).toBeDefined();
    });
    it('GET returns list snapshot', async () => {
      registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
      const r = await fetch(`http://127.0.0.1:${port}/api/sessions`);
      expect(r.status).toBe(200);
      const list = await r.json();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ id: 's1', state: 'starting' });
    });
    it('DELETE removes', async () => {
      registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
      const r = await fetch(`http://127.0.0.1:${port}/api/sessions/s1`, { method: 'DELETE' });
      expect(r.status).toBe(204);
      expect(registry.get('s1')).toBeUndefined();
    });
    it('POST with invalid body returns 400', async () => {
      const r = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":"only"}',
      });
      expect(r.status).toBe(400);
    });
  });
  ```

- [ ] **Step 2: Extend `packages/hub/src/rest/server.ts` to handle /api/sessions**

  Add these helpers near the existing `route` function:

  ```typescript
  import { z } from 'zod';

  async function readJson(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  }

  const RegisterBody = z.object({
    id:              z.string(),
    name:            z.string(),
    agent:           z.enum(['claude-code', 'codex', 'gemini', 'other']),
    cwd:             z.string(),
    pid:             z.number().int(),
    sessionFilePath: z.string(),
  });
  ```

  Replace the `route` function body:

  ```typescript
  async function route(req: IncomingMessage, res: ServerResponse, deps: RestServerDeps): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const method = req.method ?? 'GET';

    if (url.pathname === '/api/health') return health(method, res);

    if (url.pathname === '/api/sessions') {
      if (method === 'GET')  return listSessions(res, deps);
      if (method === 'POST') return registerSession(req, res, deps);
      return void res.writeHead(405).end();
    }
    const m = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (m) {
      const id = m[1]!;
      if (method === 'DELETE') return unregisterSession(id, res, deps);
      return void res.writeHead(405).end();
    }
    res.writeHead(404).end();
  }

  function listSessions(res: ServerResponse, deps: RestServerDeps): void {
    res.writeHead(200, { 'content-type': 'application/json' })
       .end(JSON.stringify(deps.registry.list()));
  }

  async function registerSession(req: IncomingMessage, res: ServerResponse, deps: RestServerDeps): Promise<void> {
    let body: unknown;
    try { body = await readJson(req); } catch { return void res.writeHead(400).end('bad json'); }
    const parsed = RegisterBody.safeParse(body);
    if (!parsed.success) return void res.writeHead(400, { 'content-type': 'application/json' })
                                 .end(JSON.stringify({ error: parsed.error.format() }));
    const rec = deps.registry.register(parsed.data);
    res.writeHead(201, { 'content-type': 'application/json' })
       .end(JSON.stringify({ id: rec.id, registeredAt: rec.startedAt }));
  }

  function unregisterSession(id: string, res: ServerResponse, deps: RestServerDeps): void {
    const removed = deps.registry.unregister(id);
    if (!removed) return void res.writeHead(404).end();
    res.writeHead(204).end();
  }
  ```

- [ ] **Step 3: Run, expect pass.**

- [ ] **Step 4: Commit**

  ```bash
  git add packages/hub/src/rest/
  git commit -m "hub: REST /api/sessions register/list/unregister"
  ```

### Task 20: REST `/api/sessions/:id/heartbeat`

**Files:**
- Modify: `packages/hub/src/rest/server.ts`, `packages/hub/src/registry/session-registry.ts`
- Modify: `packages/hub/src/rest/sessions.test.ts` (append)

- [ ] **Step 1: Add `lastHeartbeat` to SessionRecord**

  In `session-registry.ts`, add `lastHeartbeat: number` to `SessionRecord`, set it to `Date.now()` in `register`, and add a method:

  ```typescript
  recordHeartbeat(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.lastHeartbeat = Date.now();
    return true;
  }
  ```

- [ ] **Step 2: Add test case**

  Append to `sessions.test.ts`:

  ```typescript
  describe('heartbeat', () => {
    it('POST /api/sessions/:id/heartbeat updates lastHeartbeat', async () => {
      const before = Date.now();
      registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
      const r = await fetch(`http://127.0.0.1:${port}/api/sessions/s1/heartbeat`, { method: 'POST' });
      expect(r.status).toBe(204);
      const rec = registry.get('s1');
      expect(rec!.lastHeartbeat).toBeGreaterThanOrEqual(before);
    });
    it('returns 404 for unknown session', async () => {
      const r = await fetch(`http://127.0.0.1:${port}/api/sessions/missing/heartbeat`, { method: 'POST' });
      expect(r.status).toBe(404);
    });
  });
  ```

- [ ] **Step 3: Add route handling**

  In `server.ts` `route`, add before the generic `^/api/sessions/([^/]+)$` regex:

  ```typescript
  const hb = url.pathname.match(/^\/api\/sessions\/([^/]+)\/heartbeat$/);
  if (hb) {
    const id = hb[1]!;
    if (method !== 'POST') return void res.writeHead(405).end();
    const ok = deps.registry.recordHeartbeat(id);
    return void res.writeHead(ok ? 204 : 404).end();
  }
  ```

- [ ] **Step 4: Run + commit**

  ```bash
  pnpm test
  git add packages/hub/src/
  git commit -m "hub: REST /api/sessions/:id/heartbeat"
  ```

### Task 21: REST `/hooks` ingest stub

**Files:**
- Modify: `packages/hub/src/rest/server.ts`
- Create: `packages/hub/src/rest/hooks.test.ts`

This task only ACCEPTS the POST and writes to the registry's substate. The real observer pipeline lands in T26.

- [ ] **Step 1: Test**

  ```typescript
  // packages/hub/src/rest/hooks.test.ts
  import { describe, it, expect, beforeEach, afterEach } from 'vitest';
  import { createRestServer, type RestServer } from './server.js';
  import { SessionRegistry } from '../registry/session-registry.js';

  let svr: RestServer; let port: number; let registry: SessionRegistry;
  beforeEach(async () => {
    registry = new SessionRegistry();
    registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    svr = createRestServer({ registry });
    await svr.listen(0, '127.0.0.1');
    port = svr.address().port;
  });
  afterEach(async () => { await svr.close(); });

  describe('/hooks', () => {
    it('POST returns 204 for valid envelope', async () => {
      const body = { agent: 'claude-code', sessionId: 's1', ts: Date.now(), event: 'Stop', raw: { nativeEvent: 'Stop' } };
      const r = await fetch(`http://127.0.0.1:${port}/hooks`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(r.status).toBe(204);
    });
    it('POST 400 on malformed body', async () => {
      const r = await fetch(`http://127.0.0.1:${port}/hooks`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      expect(r.status).toBe(400);
    });
    it('POST 404 for unknown session', async () => {
      const body = { agent: 'claude-code', sessionId: 'missing', ts: 0, event: 'Stop', raw: {} };
      const r = await fetch(`http://127.0.0.1:${port}/hooks`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(r.status).toBe(404);
    });
  });
  ```

- [ ] **Step 2: Extend server.ts**

  Add the schema near the others:

  ```typescript
  const HookBody = z.object({
    agent:     z.enum(['claude-code','codex','gemini','other']),
    sessionId: z.string(),
    ts:        z.number().int(),
    event:     z.string(),
    raw:       z.record(z.string(), z.unknown()),
  });
  ```

  Add to `route`:

  ```typescript
  if (url.pathname === '/hooks') {
    if (method !== 'POST') return void res.writeHead(405).end();
    return ingestHook(req, res, deps);
  }
  ```

  Add the handler:

  ```typescript
  async function ingestHook(req: IncomingMessage, res: ServerResponse, deps: RestServerDeps): Promise<void> {
    let body: unknown;
    try { body = await readJson(req); } catch { return void res.writeHead(400).end('bad json'); }
    const parsed = HookBody.safeParse(body);
    if (!parsed.success) return void res.writeHead(400).end();
    if (!deps.registry.get(parsed.data.sessionId)) return void res.writeHead(404).end();
    // Real ingest pipeline lands in T26 (observers/hook-ingest.ts).
    // For now we just acknowledge; the registry is updated in observers/.
    deps.onHookEvent?.(parsed.data);
    res.writeHead(204).end();
  }
  ```

  Extend `RestServerDeps`:

  ```typescript
  export interface RestServerDeps {
    registry: SessionRegistry;
    /** Fired when a valid hook event arrives. Wired in T26. */
    onHookEvent?: (envelope: { agent: string; sessionId: string; ts: number; event: string; raw: Record<string, unknown> }) => void;
  }
  ```

- [ ] **Step 3: Run + commit.**

  ```bash
  pnpm test
  git add packages/hub/src/rest/
  git commit -m "hub: REST /hooks accept envelope (observer pipeline stubbed)"
  ```

### Task 22: M3 milestone checkpoint

- [ ] **Step 1: All hub + shared + hook-handler tests pass**

  ```bash
  cd /home/jiangzhuo/Desktop/kizunaai/sesshin
  pnpm test
  ```

- [ ] **Step 2: Tag**

  ```bash
  git tag M3
  ```

---

## Milestone M4: State machine, agents/claude, observers, event bus

End of M4 leaves the hub fully ingesting events from hooks + JSONL + PTY tap, with state transitions and substate updates flowing through, but no WS surface yet.

### Task 23: Event bus

**Files:**
- Create: `packages/hub/src/event-bus.ts`, `packages/hub/src/event-bus.test.ts`

- [ ] **Step 1: Test**

  ```typescript
  // packages/hub/src/event-bus.test.ts
  import { describe, it, expect } from 'vitest';
  import { EventBus, type NormalizedEvent } from './event-bus.js';

  describe('EventBus', () => {
    it('emits to all listeners', () => {
      const bus = new EventBus();
      const seen: string[] = [];
      bus.on((e) => seen.push(e.kind));
      bus.on((e) => seen.push('also-' + e.kind));
      bus.emit({ sessionId: 's1', kind: 'user-prompt', payload: {}, source: 'observer:hook-ingest', ts: 1, eventId: 'e1' });
      expect(seen).toEqual(['user-prompt', 'also-user-prompt']);
    });
    it('stops emitting to a removed listener', () => {
      const bus = new EventBus();
      const seen: string[] = [];
      const fn = (e: NormalizedEvent) => seen.push(e.kind);
      bus.on(fn);
      bus.off(fn);
      bus.emit({ sessionId: 's1', kind: 'user-prompt', payload: {}, source: 'observer:hook-ingest', ts: 1, eventId: 'e1' });
      expect(seen).toEqual([]);
    });
  });
  ```

- [ ] **Step 2: Implement**

  ```typescript
  // packages/hub/src/event-bus.ts
  import type { EventKind } from '@sesshin/shared';

  export interface NormalizedEvent {
    eventId:    string;
    sessionId:  string;
    kind:       EventKind;
    payload:    Record<string, unknown>;
    source:     string;
    ts:         number;
    nativeEvent?: string;
  }
  type Listener = (e: NormalizedEvent) => void;

  export class EventBus {
    private listeners = new Set<Listener>();
    on(fn: Listener): void { this.listeners.add(fn); }
    off(fn: Listener): void { this.listeners.delete(fn); }
    emit(e: NormalizedEvent): void { for (const fn of this.listeners) fn(e); }
  }
  ```

- [ ] **Step 3: Run + commit**

  ```bash
  pnpm test
  git add packages/hub/src/event-bus.ts packages/hub/src/event-bus.test.ts
  git commit -m "hub: event bus"
  ```

### Task 24: Agents/claude — normalize hook event

**Files:**
- Create: `packages/hub/src/agents/claude/normalize-hook.ts`, `packages/hub/src/agents/claude/normalize-hook.test.ts`

- [ ] **Step 1: Test**

  ```typescript
  // packages/hub/src/agents/claude/normalize-hook.test.ts
  import { describe, it, expect } from 'vitest';
  import { hookEnvelopeToEvent } from './normalize-hook.js';

  describe('hookEnvelopeToEvent', () => {
    it('UserPromptSubmit → user-prompt', () => {
      const e = hookEnvelopeToEvent({
        agent: 'claude-code', sessionId: 's1', ts: 1000,
        event: 'UserPromptSubmit',
        raw: { nativeEvent: 'UserPromptSubmit', prompt: 'do it' },
      });
      expect(e.kind).toBe('user-prompt');
      expect(e.payload).toMatchObject({ prompt: 'do it' });
      expect(e.source).toBe('observer:hook-ingest');
    });
    it('PreToolUse → tool-call', () => {
      const e = hookEnvelopeToEvent({
        agent: 'claude-code', sessionId: 's1', ts: 1, event: 'PreToolUse',
        raw: { nativeEvent: 'PreToolUse', tool_name: 'Edit', tool_input: { file: 'a' } },
      });
      expect(e.kind).toBe('tool-call');
      expect(e.payload).toMatchObject({ tool: 'Edit' });
    });
    it('PostToolUse → tool-result', () => {
      const e = hookEnvelopeToEvent({
        agent: 'claude-code', sessionId: 's1', ts: 1, event: 'PostToolUse',
        raw: { nativeEvent: 'PostToolUse', tool_name: 'Bash', tool_response: 'ok' },
      });
      expect(e.kind).toBe('tool-result');
    });
    it('Stop → agent-output', () => {
      const e = hookEnvelopeToEvent({
        agent: 'claude-code', sessionId: 's1', ts: 1, event: 'Stop',
        raw: { nativeEvent: 'Stop' },
      });
      expect(e.kind).toBe('agent-output');
    });
    it('StopFailure → error', () => {
      const e = hookEnvelopeToEvent({
        agent: 'claude-code', sessionId: 's1', ts: 1, event: 'StopFailure',
        raw: { nativeEvent: 'StopFailure', error: 'boom' },
      });
      expect(e.kind).toBe('error');
    });
    it('agent-internal events pass through with kind:agent-internal', () => {
      const e = hookEnvelopeToEvent({
        agent: 'claude-code', sessionId: 's1', ts: 1, event: 'agent-internal',
        raw: { nativeEvent: 'WeirdNewEvent' },
      });
      expect(e.kind).toBe('agent-internal');
    });
  });
  ```

- [ ] **Step 2: Implement**

  ```typescript
  // packages/hub/src/agents/claude/normalize-hook.ts
  import { randomUUID } from 'node:crypto';
  import type { EventKind } from '@sesshin/shared';
  import type { NormalizedEvent } from '../../event-bus.js';

  export interface HookEnvelope {
    agent: string;
    sessionId: string;
    ts: number;
    event: string;
    raw: Record<string, unknown>;
  }

  export function hookEnvelopeToEvent(env: HookEnvelope): NormalizedEvent {
    const { kind, payload } = mapEvent(env.event, env.raw);
    return {
      eventId: randomUUID(),
      sessionId: env.sessionId,
      kind,
      payload,
      source: 'observer:hook-ingest',
      ts: env.ts,
      nativeEvent: typeof env.raw['nativeEvent'] === 'string' ? env.raw['nativeEvent'] : env.event,
    };
  }

  function mapEvent(event: string, raw: Record<string, unknown>): { kind: EventKind; payload: Record<string, unknown> } {
    switch (event) {
      case 'SessionStart':
        return { kind: 'agent-internal', payload: { phase: 'session-start' } };
      case 'UserPromptSubmit':
        return { kind: 'user-prompt', payload: { prompt: pick(raw, 'prompt') } };
      case 'PreToolUse':
        return { kind: 'tool-call', payload: { tool: pick(raw, 'tool_name'), input: raw['tool_input'] } };
      case 'PostToolUse':
        return { kind: 'tool-result', payload: { tool: pick(raw, 'tool_name'), result: raw['tool_response'] } };
      case 'Stop':
        return { kind: 'agent-output', payload: { stopReason: pick(raw, 'stop_reason') } };
      case 'StopFailure':
        return { kind: 'error', payload: { error: pick(raw, 'error') ?? 'unknown' } };
      case 'SessionEnd':
        return { kind: 'agent-internal', payload: { phase: 'session-end' } };
      default:
        return { kind: 'agent-internal', payload: { ...raw } };
    }
  }

  function pick<T extends Record<string, unknown>>(o: T, key: string): unknown {
    return o[key];
  }
  ```

- [ ] **Step 3: Run + commit**

  ```bash
  pnpm test
  git add packages/hub/src/agents/claude/normalize-hook.ts packages/hub/src/agents/claude/normalize-hook.test.ts
  git commit -m "hub: agents/claude hook envelope → normalized event"
  ```

### Task 25: Agents/claude — session file path computation

**Files:**
- Create: `packages/hub/src/agents/claude/session-file-path.ts`, `packages/hub/src/agents/claude/session-file-path.test.ts`

- [ ] **Step 1: Test (encoding rule confirmed in T2 verification gate)**

  ```typescript
  import { describe, it, expect } from 'vitest';
  import { encodeCwdForClaudeProjects, sessionFilePath } from './session-file-path.js';

  describe('encodeCwdForClaudeProjects', () => {
    it('replaces / with - and removes leading dash issue', () => {
      // Encoding determined by gate 2; placeholder rule mirrors observed behavior.
      expect(encodeCwdForClaudeProjects('/home/me/proj')).toBe('-home-me-proj');
    });
  });
  describe('sessionFilePath', () => {
    it('joins projects/<encoded>/<session>.jsonl under home', () => {
      const p = sessionFilePath({ home: '/h', cwd: '/home/me/proj', sessionId: 'abc' });
      expect(p).toBe('/h/.claude/projects/-home-me-proj/abc.jsonl');
    });
  });
  ```

- [ ] **Step 2: Implement (matching the encoding documented in `docs/validation-log.md` §12.2)**

  ```typescript
  import { join } from 'node:path';

  /**
   * Encoding rule for ~/.claude/projects/<encoded>/ directories.
   * Confirmed empirically in validation gate 2 (docs/validation-log.md §12.2).
   * Adjust THIS FUNCTION if gate 2 reveals a different rule.
   */
  export function encodeCwdForClaudeProjects(cwd: string): string {
    return cwd.replaceAll('/', '-');
  }

  export function sessionFilePath(o: { home: string; cwd: string; sessionId: string }): string {
    return join(o.home, '.claude', 'projects', encodeCwdForClaudeProjects(o.cwd), `${o.sessionId}.jsonl`);
  }
  ```

- [ ] **Step 3: Run + commit**

  ```bash
  pnpm test
  git add packages/hub/src/agents/claude/session-file-path.ts packages/hub/src/agents/claude/session-file-path.test.ts
  git commit -m "hub: agents/claude session JSONL path computation"
  ```

### Task 26: Observer: hook-ingest

**Files:**
- Create: `packages/hub/src/observers/hook-ingest.ts`, `packages/hub/src/observers/hook-ingest.test.ts`

- [ ] **Step 1: Test**

  ```typescript
  // packages/hub/src/observers/hook-ingest.test.ts
  import { describe, it, expect } from 'vitest';
  import { EventBus } from '../event-bus.js';
  import { wireHookIngest } from './hook-ingest.js';
  import { SessionRegistry } from '../registry/session-registry.js';

  describe('wireHookIngest', () => {
    it('Claude hook envelope produces a normalized event on the bus', () => {
      const bus = new EventBus();
      const reg = new SessionRegistry();
      reg.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/c', pid: 1, sessionFilePath: '/p' });
      const events: any[] = [];
      bus.on((e) => events.push(e));
      const ingest = wireHookIngest({ bus, registry: reg });
      ingest({ agent: 'claude-code', sessionId: 's1', ts: 1, event: 'Stop', raw: { nativeEvent: 'Stop' } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ sessionId: 's1', kind: 'agent-output' });
    });
    it('drops envelopes for unknown sessions', () => {
      const bus = new EventBus();
      const events: any[] = [];
      bus.on((e) => events.push(e));
      const ingest = wireHookIngest({ bus, registry: new SessionRegistry() });
      ingest({ agent: 'claude-code', sessionId: 'missing', ts: 1, event: 'Stop', raw: {} });
      expect(events).toHaveLength(0);
    });
    it('routes non-claude agents to the agent-internal pass-through (v1 only Claude)', () => {
      const bus = new EventBus();
      const reg = new SessionRegistry();
      reg.register({ id: 's2', name: 'n', agent: 'other', cwd: '/c', pid: 1, sessionFilePath: '/p' });
      const events: any[] = [];
      bus.on((e) => events.push(e));
      const ingest = wireHookIngest({ bus, registry: reg });
      ingest({ agent: 'other', sessionId: 's2', ts: 1, event: 'Whatever', raw: {} });
      expect(events[0].kind).toBe('agent-internal');
    });
  });
  ```

- [ ] **Step 2: Implement**

  ```typescript
  // packages/hub/src/observers/hook-ingest.ts
  import type { EventBus } from '../event-bus.js';
  import type { SessionRegistry } from '../registry/session-registry.js';
  import { hookEnvelopeToEvent, type HookEnvelope } from '../agents/claude/normalize-hook.js';

  export interface HookIngestDeps { bus: EventBus; registry: SessionRegistry }

  export function wireHookIngest(deps: HookIngestDeps): (env: HookEnvelope) => void {
    return (env) => {
      if (!deps.registry.get(env.sessionId)) return;
      const event = hookEnvelopeToEvent(env);
      deps.bus.emit(event);
    };
  }
  ```

- [ ] **Step 3: Run + commit**

  ```bash
  pnpm test
  git add packages/hub/src/observers/
  git commit -m "hub: observers/hook-ingest — envelope → bus"
  ```

### Task 27: State machine

**Files:**
- Create: `packages/hub/src/state-machine/machine.ts`, `packages/hub/src/state-machine/machine.test.ts`

The transitions table is taken from `docs/state-machine.md`. The "Stop with question" heuristic is deferred to summarizer integration (T39); for now we treat all `Stop` events as transitioning to `idle`.

- [ ] **Step 1: Test**

  ```typescript
  // packages/hub/src/state-machine/machine.test.ts
  import { describe, it, expect } from 'vitest';
  import { transitionFor } from './machine.js';

  describe('transitionFor', () => {
    it('SessionStart from starting → idle', () => {
      expect(transitionFor('starting', { kind: 'agent-internal', nativeEvent: 'SessionStart' })).toBe('idle');
    });
    it('user-prompt from idle → running', () => {
      expect(transitionFor('idle', { kind: 'user-prompt' })).toBe('running');
    });
    it('user-prompt from awaiting-input → running', () => {
      expect(transitionFor('awaiting-input', { kind: 'user-prompt' })).toBe('running');
    });
    it('agent-output (Stop) from running → idle (heuristic deferred)', () => {
      expect(transitionFor('running', { kind: 'agent-output' })).toBe('idle');
    });
    it('error event from running → error', () => {
      expect(transitionFor('running', { kind: 'error' })).toBe('error');
    });
    it('SessionEnd from any → done', () => {
      expect(transitionFor('idle', { kind: 'agent-internal', nativeEvent: 'SessionEnd' })).toBe('done');
      expect(transitionFor('running', { kind: 'agent-internal', nativeEvent: 'SessionEnd' })).toBe('done');
    });
    it('returns null when no transition applies (state stays put)', () => {
      expect(transitionFor('idle', { kind: 'tool-call' })).toBeNull();
    });
  });
  ```

- [ ] **Step 2: Implement**

  ```typescript
  // packages/hub/src/state-machine/machine.ts
  import type { SessionState, EventKind, NormalizedHookEvent } from '@sesshin/shared';

  export interface EventLite {
    kind: EventKind;
    nativeEvent?: string;
  }

  export function transitionFor(state: SessionState, e: EventLite): SessionState | null {
    if (e.kind === 'agent-internal') {
      if (e.nativeEvent === 'SessionStart' && state === 'starting') return 'idle';
      if (e.nativeEvent === 'SessionEnd') return 'done';
      return null;
    }
    if (e.kind === 'user-prompt' && (state === 'idle' || state === 'awaiting-input' || state === 'error')) return 'running';
    if (e.kind === 'tool-call'  && state === 'running') return null;  // substate update only
    if (e.kind === 'tool-result' && (state === 'running' || state === 'awaiting-confirmation')) return 'running';
    if (e.kind === 'agent-output' && state === 'running') return 'idle';   // heuristic: idle for now; awaiting-input set by summarizer in T39
    if (e.kind === 'error' && state === 'running') return 'error';
    return null;
  }
  ```

- [ ] **Step 3: Run + commit**

  ```bash
  pnpm test
  git add packages/hub/src/state-machine/
  git commit -m "hub: state machine transitions table"
  ```

### Task 28: Wire state machine + substate updates to event bus

**Files:**
- Create: `packages/hub/src/state-machine/applier.ts`, `packages/hub/src/state-machine/applier.test.ts`

- [ ] **Step 1: Test**

  ```typescript
  import { describe, it, expect } from 'vitest';
  import { wireStateMachine } from './applier.js';
  import { EventBus } from '../event-bus.js';
  import { SessionRegistry } from '../registry/session-registry.js';

  describe('wireStateMachine', () => {
    it('user-prompt drives idle → running and resets elapsedSinceProgressMs', () => {
      const bus = new EventBus(); const reg = new SessionRegistry();
      reg.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
      reg.updateState('s1', 'idle');
      reg.patchSubstate('s1', { elapsedSinceProgressMs: 9999 });
      wireStateMachine({ bus, registry: reg });
      bus.emit({ eventId: 'e', sessionId: 's1', kind: 'user-prompt', payload: {}, source: 'observer:hook-ingest', ts: 1 });
      expect(reg.get('s1')!.state).toBe('running');
      expect(reg.get('s1')!.substate.elapsedSinceProgressMs).toBe(0);
    });
    it('tool-call updates currentTool', () => {
      const bus = new EventBus(); const reg = new SessionRegistry();
      reg.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
      reg.updateState('s1', 'running');
      wireStateMachine({ bus, registry: reg });
      bus.emit({ eventId: 'e', sessionId: 's1', kind: 'tool-call', payload: { tool: 'Edit' }, source: 'observer:hook-ingest', ts: 1 });
      expect(reg.get('s1')!.substate.currentTool).toBe('Edit');
    });
    it('tool-result records lastTool, clears currentTool', () => {
      const bus = new EventBus(); const reg = new SessionRegistry();
      reg.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
      reg.updateState('s1', 'running');
      reg.patchSubstate('s1', { currentTool: 'Read' });
      wireStateMachine({ bus, registry: reg });
      bus.emit({ eventId: 'e', sessionId: 's1', kind: 'tool-result', payload: { tool: 'Read' }, source: 'observer:hook-ingest', ts: 1 });
      expect(reg.get('s1')!.substate.currentTool).toBeNull();
      expect(reg.get('s1')!.substate.lastTool).toBe('Read');
    });
  });
  ```

- [ ] **Step 2: Implement**

  ```typescript
  // packages/hub/src/state-machine/applier.ts
  import type { EventBus, NormalizedEvent } from '../event-bus.js';
  import type { SessionRegistry } from '../registry/session-registry.js';
  import { transitionFor } from './machine.js';

  export interface ApplierDeps { bus: EventBus; registry: SessionRegistry }

  export function wireStateMachine(deps: ApplierDeps): void {
    deps.bus.on((e) => apply(e, deps.registry));
  }

  function apply(e: NormalizedEvent, registry: SessionRegistry): void {
    const session = registry.get(e.sessionId);
    if (!session) return;

    const next = transitionFor(session.state, e);
    if (next) registry.updateState(e.sessionId, next);

    // Substate updates per kind:
    if (e.kind === 'user-prompt') {
      registry.patchSubstate(e.sessionId, { elapsedSinceProgressMs: 0 });
    } else if (e.kind === 'tool-call') {
      const tool = (e.payload['tool'] as string | undefined) ?? null;
      registry.patchSubstate(e.sessionId, { currentTool: tool });
    } else if (e.kind === 'tool-result') {
      const tool = (e.payload['tool'] as string | undefined) ?? null;
      registry.patchSubstate(e.sessionId, { currentTool: null, lastTool: tool });
    }
  }
  ```

- [ ] **Step 3: Run + commit**

  ```bash
  pnpm test
  git add packages/hub/src/state-machine/applier.ts packages/hub/src/state-machine/applier.test.ts
  git commit -m "hub: state machine applier (drives registry from bus)"
  ```

### Task 29: Observer: session-file-tail

**Files:**
- Create: `packages/hub/src/agents/claude/normalize-jsonl.ts`, `packages/hub/src/agents/claude/normalize-jsonl.test.ts`, `packages/hub/src/observers/session-file-tail.ts`, `packages/hub/src/observers/session-file-tail.test.ts`

The exact JSONL line shape was captured in verification gate 2. The mapper below assumes lines are objects with a `type` field; ADJUST the mapping to match what gate 2 actually showed.

- [ ] **Step 1: Test the JSONL line normalizer**

  ```typescript
  // packages/hub/src/agents/claude/normalize-jsonl.test.ts
  import { describe, it, expect } from 'vitest';
  import { jsonlLineToEvent } from './normalize-jsonl.js';

  describe('jsonlLineToEvent', () => {
    it('maps a user-message line to user-prompt', () => {
      const line = JSON.stringify({ type: 'user', message: { content: 'hello' }, uuid: 'u-1', timestamp: '2026-05-02T12:00:00Z' });
      const e = jsonlLineToEvent('s1', line);
      expect(e?.kind).toBe('user-prompt');
      expect(e?.source).toBe('observer:session-file-tail');
    });
    it('maps a tool_use entry to tool-call', () => {
      const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { x: 1 } }] }, uuid: 'u-2', timestamp: '...' });
      const e = jsonlLineToEvent('s1', line);
      expect(e?.kind).toBe('tool-call');
    });
    it('returns null for unparseable lines', () => {
      expect(jsonlLineToEvent('s1', 'not-json')).toBeNull();
    });
  });
  ```

- [ ] **Step 2: Implement the normalizer**

  ```typescript
  // packages/hub/src/agents/claude/normalize-jsonl.ts
  import { randomUUID } from 'node:crypto';
  import type { NormalizedEvent } from '../../event-bus.js';

  export function jsonlLineToEvent(sessionId: string, line: string): NormalizedEvent | null {
    let parsed: any;
    try { parsed = JSON.parse(line); } catch { return null; }
    if (!parsed || typeof parsed !== 'object') return null;

    const ts = parseTs(parsed.timestamp);
    const eventId = randomUUID();

    if (parsed.type === 'user') {
      return {
        eventId, sessionId, ts, kind: 'user-prompt',
        payload: { prompt: extractContent(parsed.message?.content) },
        source: 'observer:session-file-tail',
      };
    }
    if (parsed.type === 'assistant') {
      const content = parsed.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'tool_use') {
            return {
              eventId, sessionId, ts, kind: 'tool-call',
              payload: { tool: block.name, input: block.input },
              source: 'observer:session-file-tail',
            };
          }
        }
      }
      return {
        eventId, sessionId, ts, kind: 'agent-output',
        payload: { content: extractContent(content) },
        source: 'observer:session-file-tail',
      };
    }
    if (parsed.type === 'user' && Array.isArray(parsed.message?.content)) {
      for (const block of parsed.message.content) {
        if (block?.type === 'tool_result') {
          return {
            eventId, sessionId, ts, kind: 'tool-result',
            payload: { tool: block.name, result: block.content },
            source: 'observer:session-file-tail',
          };
        }
      }
    }
    return { eventId, sessionId, ts, kind: 'agent-internal', payload: parsed, source: 'observer:session-file-tail' };
  }

  function parseTs(s: unknown): number {
    if (typeof s === 'string') { const t = Date.parse(s); if (!Number.isNaN(t)) return t; }
    return Date.now();
  }

  function extractContent(c: unknown): string {
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map((b) => (b?.text ?? '')).join('');
    return '';
  }
  ```

- [ ] **Step 3: Test the file tailer**

  ```typescript
  // packages/hub/src/observers/session-file-tail.test.ts
  import { describe, it, expect, beforeEach, afterEach } from 'vitest';
  import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';
  import { tailSessionFile } from './session-file-tail.js';
  import { EventBus } from '../event-bus.js';

  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sf-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  describe('tailSessionFile', () => {
    it('emits an event for each new line appended', async () => {
      const path = join(dir, 'session.jsonl');
      writeFileSync(path, ''); // start empty
      const bus = new EventBus();
      const events: any[] = [];
      bus.on((e) => events.push(e));
      const stop = tailSessionFile({ sessionId: 's1', path, bus, pollMs: 25 });
      appendFileSync(path, JSON.stringify({ type: 'user', message: { content: 'hi' }, timestamp: 0 }) + '\n');
      await new Promise((r) => setTimeout(r, 80));
      stop();
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].kind).toBe('user-prompt');
    });
    it('handles missing-file → polls until created', async () => {
      const path = join(dir, 'will-create.jsonl');
      const bus = new EventBus();
      const events: any[] = [];
      bus.on((e) => events.push(e));
      const stop = tailSessionFile({ sessionId: 's1', path, bus, pollMs: 25 });
      await new Promise((r) => setTimeout(r, 30));
      writeFileSync(path, JSON.stringify({ type: 'user', message: { content: 'hi' }, timestamp: 0 }) + '\n');
      await new Promise((r) => setTimeout(r, 80));
      stop();
      expect(events.some((e) => e.kind === 'user-prompt')).toBe(true);
    });
  });
  ```

- [ ] **Step 4: Implement the tailer**

  ```typescript
  // packages/hub/src/observers/session-file-tail.ts
  import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
  import type { EventBus } from '../event-bus.js';
  import { jsonlLineToEvent } from '../agents/claude/normalize-jsonl.js';

  export interface TailOpts {
    sessionId: string;
    path: string;
    bus: EventBus;
    pollMs?: number;
    initialCursor?: number;
  }

  export function tailSessionFile(opts: TailOpts): () => void {
    const pollMs = opts.pollMs ?? 200;
    let cursor = opts.initialCursor ?? 0;
    let buf = '';
    let stopped = false;

    const tick = (): void => {
      if (stopped) return;
      try {
        if (!existsSync(opts.path)) return;
        const st = statSync(opts.path);
        if (st.size > cursor) {
          const fd = openSync(opts.path, 'r');
          try {
            const want = st.size - cursor;
            const chunk = Buffer.alloc(want);
            readSync(fd, chunk, 0, want, cursor);
            cursor = st.size;
            buf += chunk.toString('utf-8');
          } finally { closeSync(fd); }
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            const event = jsonlLineToEvent(opts.sessionId, line);
            if (event) opts.bus.emit(event);
          }
        }
      } catch { /* ignore transient */ }
    };
    const handle = setInterval(tick, pollMs);
    return () => { stopped = true; clearInterval(handle); };
  }
  ```

- [ ] **Step 5: Run + commit**

  ```bash
  pnpm test
  git add packages/hub/src/agents/claude/normalize-jsonl.ts packages/hub/src/agents/claude/normalize-jsonl.test.ts packages/hub/src/observers/session-file-tail.ts packages/hub/src/observers/session-file-tail.test.ts
  git commit -m "hub: observers/session-file-tail + claude JSONL normalizer"
  ```

### Task 30: Observer: pty-tap (REST raw chunk acceptor + ring buffer)

**Files:**
- Create: `packages/hub/src/observers/pty-tap.ts`, `packages/hub/src/observers/pty-tap.test.ts`
- Modify: `packages/hub/src/rest/server.ts` to add `POST /api/sessions/:id/raw`

- [ ] **Step 1: Test the ring buffer + emitter**

  ```typescript
  // packages/hub/src/observers/pty-tap.test.ts
  import { describe, it, expect } from 'vitest';
  import { PtyTap } from './pty-tap.js';

  describe('PtyTap', () => {
    it('records chunks with monotonically increasing seq', () => {
      const t = new PtyTap({ ringBytes: 1024 });
      const a = t.append('s1', Buffer.from('hello '));
      const b = t.append('s1', Buffer.from('world'));
      expect(a.seq).toBe(6);
      expect(b.seq).toBe(11);
      expect(t.snapshot('s1').toString('utf-8')).toBe('hello world');
    });
    it('rotates the ring buffer at the byte limit', () => {
      const t = new PtyTap({ ringBytes: 8 });
      t.append('s1', Buffer.from('1234567890'));  // 10 bytes; ring keeps last <=8
      const snap = t.snapshot('s1').toString('utf-8');
      expect(snap.length).toBeLessThanOrEqual(8);
      expect(snap.endsWith('0')).toBe(true);
    });
    it('emits to subscribers', () => {
      const t = new PtyTap({ ringBytes: 1024 });
      const seen: string[] = [];
      const off = t.subscribe('s1', (chunk) => seen.push(chunk.toString('utf-8')));
      t.append('s1', Buffer.from('a'));
      t.append('s1', Buffer.from('b'));
      off();
      t.append('s1', Buffer.from('c'));  // no longer received
      expect(seen).toEqual(['a', 'b']);
    });
  });
  ```

- [ ] **Step 2: Implement**

  ```typescript
  // packages/hub/src/observers/pty-tap.ts
  type Subscriber = (chunk: Buffer, seq: number) => void;

  interface SessionRing {
    buf: Buffer;
    used: number;     // bytes currently in buf
    seq: number;      // running byte counter (never decreases)
    subs: Set<Subscriber>;
  }

  export class PtyTap {
    private rings = new Map<string, SessionRing>();
    constructor(private opts: { ringBytes: number }) {}

    append(sessionId: string, chunk: Buffer): { seq: number } {
      const r = this.ring(sessionId);
      r.seq += chunk.length;
      // Append + rotate
      if (chunk.length >= this.opts.ringBytes) {
        chunk.copy(r.buf, 0, chunk.length - this.opts.ringBytes);
        r.used = this.opts.ringBytes;
      } else if (r.used + chunk.length <= this.opts.ringBytes) {
        chunk.copy(r.buf, r.used);
        r.used += chunk.length;
      } else {
        const drop = r.used + chunk.length - this.opts.ringBytes;
        r.buf.copy(r.buf, 0, drop, r.used);
        r.used -= drop;
        chunk.copy(r.buf, r.used);
        r.used += chunk.length;
      }
      for (const sub of r.subs) sub(chunk, r.seq);
      return { seq: r.seq };
    }

    snapshot(sessionId: string): Buffer {
      const r = this.rings.get(sessionId);
      if (!r) return Buffer.alloc(0);
      return r.buf.slice(0, r.used);
    }

    subscribe(sessionId: string, sub: Subscriber): () => void {
      const r = this.ring(sessionId);
      r.subs.add(sub);
      return () => r.subs.delete(sub);
    }

    drop(sessionId: string): void { this.rings.delete(sessionId); }

    private ring(sessionId: string): SessionRing {
      let r = this.rings.get(sessionId);
      if (!r) {
        r = { buf: Buffer.alloc(this.opts.ringBytes), used: 0, seq: 0, subs: new Set() };
        this.rings.set(sessionId, r);
      }
      return r;
    }
  }
  ```

- [ ] **Step 3: Add `POST /api/sessions/:id/raw` to REST**

  In `packages/hub/src/rest/server.ts`:
  - Add `tap?: PtyTap` to `RestServerDeps`.
  - In `route`, before generic session-id matching, add:

    ```typescript
    const raw = url.pathname.match(/^\/api\/sessions\/([^/]+)\/raw$/);
    if (raw) {
      const id = raw[1]!;
      if (method !== 'POST') return void res.writeHead(405).end();
      if (!deps.registry.get(id)) return void res.writeHead(404).end();
      if (!deps.tap) return void res.writeHead(501).end();
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      deps.tap.append(id, Buffer.concat(chunks));
      return void res.writeHead(204).end();
    }
    ```

- [ ] **Step 4: Test the REST integration (append to `packages/hub/src/rest/sessions.test.ts`)**

  ```typescript
  describe('/api/sessions/:id/raw', () => {
    it('writes received bytes into the PtyTap', async () => {
      const { PtyTap } = await import('../observers/pty-tap.js');
      const tap = new PtyTap({ ringBytes: 1024 });
      const localRegistry = new SessionRegistry();
      localRegistry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
      const localSvr = createRestServer({ registry: localRegistry, tap });
      await localSvr.listen(0, '127.0.0.1');
      const localPort = localSvr.address().port;
      const r = await fetch(`http://127.0.0.1:${localPort}/api/sessions/s1/raw`, { method: 'POST', body: 'hello' });
      expect(r.status).toBe(204);
      expect(tap.snapshot('s1').toString('utf-8')).toBe('hello');
      await localSvr.close();
    });
  });
  ```

- [ ] **Step 5: Run + commit**

  ```bash
  pnpm test
  git add packages/hub/src/observers/ packages/hub/src/rest/
  git commit -m "hub: PtyTap ring buffer + REST /api/sessions/:id/raw"
  ```

### Task 31: Cross-source dedup

**Files:**
- Create: `packages/hub/src/observers/dedup.ts`, `packages/hub/src/observers/dedup.test.ts`

- [ ] **Step 1: Test**

  ```typescript
  // packages/hub/src/observers/dedup.test.ts
  import { describe, it, expect } from 'vitest';
  import { Dedup } from './dedup.js';

  describe('Dedup', () => {
    it('passes the first event of a (sid, kind) within window', () => {
      const d = new Dedup({ windowMs: 2000 });
      expect(d.shouldEmit({ sessionId: 's1', kind: 'user-prompt', ts: 1000, source: 'observer:hook-ingest' })).toBe(true);
    });
    it('suppresses a near-duplicate from the other source', () => {
      const d = new Dedup({ windowMs: 2000 });
      d.shouldEmit({ sessionId: 's1', kind: 'user-prompt', ts: 1000, source: 'observer:hook-ingest' });
      expect(d.shouldEmit({ sessionId: 's1', kind: 'user-prompt', ts: 1500, source: 'observer:session-file-tail' })).toBe(false);
    });
    it('emits if outside the window', () => {
      const d = new Dedup({ windowMs: 2000 });
      d.shouldEmit({ sessionId: 's1', kind: 'user-prompt', ts: 1000, source: 'observer:hook-ingest' });
      expect(d.shouldEmit({ sessionId: 's1', kind: 'user-prompt', ts: 4000, source: 'observer:session-file-tail' })).toBe(true);
    });
  });
  ```

- [ ] **Step 2: Implement**

  ```typescript
  // packages/hub/src/observers/dedup.ts
  export interface DedupKey { sessionId: string; kind: string; ts: number; source: string }

  export class Dedup {
    private last = new Map<string, number>();   // key → ts of last emit
    constructor(private opts: { windowMs: number }) {}

    shouldEmit(k: DedupKey): boolean {
      const tag = `${k.sessionId}|${k.kind}`;
      const lastTs = this.last.get(tag);
      if (lastTs !== undefined && k.ts - lastTs < this.opts.windowMs) return false;
      this.last.set(tag, k.ts);
      return true;
    }
  }
  ```

- [ ] **Step 3: Run + commit**

  ```bash
  pnpm test
  git add packages/hub/src/observers/dedup.ts packages/hub/src/observers/dedup.test.ts
  git commit -m "hub: cross-source event dedup"
  ```

### Task 32: Wire it all in main + REST integration

**Files:**
- Modify: `packages/hub/src/main.ts`
- Create: `packages/hub/src/wire.ts` (centralized composition)

- [ ] **Step 1: `packages/hub/src/wire.ts`**

  ```typescript
  import { homedir } from 'node:os';
  import { config } from './config.js';
  import { log } from './logger.js';
  import { SessionRegistry } from './registry/session-registry.js';
  import { Checkpoint } from './registry/checkpoint.js';
  import { EventBus } from './event-bus.js';
  import { wireHookIngest } from './observers/hook-ingest.js';
  import { wireStateMachine } from './state-machine/applier.js';
  import { Dedup } from './observers/dedup.js';
  import { PtyTap } from './observers/pty-tap.js';
  import { tailSessionFile } from './observers/session-file-tail.js';
  import { createRestServer, type RestServer } from './rest/server.js';

  export interface HubInstance {
    rest: RestServer;
    registry: SessionRegistry;
    bus: EventBus;
    tap: PtyTap;
    shutdown: () => Promise<void>;
  }

  export async function startHub(): Promise<HubInstance> {
    const registry = new SessionRegistry();
    const bus      = new EventBus();
    const tap      = new PtyTap({ ringBytes: config.rawRingBytes });
    const checkpoint = new Checkpoint(registry, { path: config.sessionsCheckpointFile, debounceMs: 100 });
    const dedup    = new Dedup({ windowMs: 2000 });

    // Restore from checkpoint (best-effort).
    for (const r of checkpoint.load().sessions) {
      try { registry.register({ id: r.id, name: r.name, agent: r.agent, cwd: r.cwd, pid: r.pid, sessionFilePath: r.sessionFilePath }); }
      catch (e) { log.warn({ err: e, id: r.id }, 'failed to restore session'); }
    }
    checkpoint.start();

    // Wire dedup + state machine to bus
    const dedupedBus = new EventBus();
    bus.on((e) => {
      if (dedup.shouldEmit({ sessionId: e.sessionId, kind: e.kind, ts: e.ts, source: e.source })) {
        dedupedBus.emit(e);
      }
    });
    wireStateMachine({ bus: dedupedBus, registry });

    // Hook ingest
    const onHookEvent = wireHookIngest({ bus, registry });

    // Start session-file-tail per registered session
    const stopTails = new Map<string, () => void>();
    const startTail = (id: string): void => {
      const s = registry.get(id);
      if (!s || stopTails.has(id)) return;
      stopTails.set(id, tailSessionFile({ sessionId: id, path: s.sessionFilePath, bus, pollMs: 200, initialCursor: s.fileTailCursor }));
    };
    registry.on('session-added', (info) => startTail(info.id));
    registry.on('session-removed', (id) => { stopTails.get(id)?.(); stopTails.delete(id); tap.drop(id); });
    for (const s of registry.list()) startTail(s.id);

    // REST server
    const rest = createRestServer({ registry, tap, onHookEvent });
    await rest.listen(config.internalPort, config.internalHost);
    log.info({ port: config.internalPort }, 'hub REST listening');

    return {
      rest, registry, bus, tap,
      shutdown: async () => {
        for (const s of stopTails.values()) s();
        checkpoint.stop();
        await rest.close();
      },
    };
  }
  ```

- [ ] **Step 2: Replace `packages/hub/src/main.ts`**

  ```typescript
  import { log } from './logger.js';
  import { startHub } from './wire.js';

  async function main(): Promise<void> {
    const hub = await startHub();
    const onSig = (): never => { hub.shutdown().finally(() => process.exit(0)); throw new Error(); };
    process.on('SIGINT', onSig);
    process.on('SIGTERM', onSig);
    log.info('sesshin-hub ready');
    await new Promise<void>(() => {});
  }
  main().catch((e) => { log.fatal({ err: e }, 'fatal'); process.exit(1); });
  ```

- [ ] **Step 3: Build + smoke test**

  ```bash
  cd packages/hub && pnpm build
  node dist/main.js &
  HUB_PID=$!
  sleep 0.5
  curl -s http://127.0.0.1:9663/api/health
  echo
  curl -s -X POST -H 'content-type: application/json' \
    -d '{"id":"s1","name":"smoke","agent":"claude-code","cwd":"/tmp","pid":1,"sessionFilePath":"/tmp/no.jsonl"}' \
    http://127.0.0.1:9663/api/sessions
  echo
  curl -s http://127.0.0.1:9663/api/sessions
  echo
  kill $HUB_PID
  ```

  Expected: `{"ok":true}` then `{"id":"s1","registeredAt":...}` then a one-element array.

- [ ] **Step 4: Commit**

  ```bash
  git add packages/hub/src/wire.ts packages/hub/src/main.ts
  git commit -m "hub: wire registry + bus + observers + REST in main"
  ```

### Task 33: M4 milestone checkpoint + clear known stubs

- [ ] **Step 1: Run all tests**

  ```bash
  pnpm test
  ```

- [ ] **Step 2: Tag**

  ```bash
  git tag M4
  ```

The hub now ingests events from hooks + JSONL + PTY tap, deduplicates them, and updates state and substate. No WS, no summarizer, no `inject` endpoint yet. M5 adds WS; M6 adds the summarizer; the inject endpoint lands in M5 alongside input arbitration.

---

## Milestone M5: WS server, capability gating, input arbitration

### Task 34: WS server skeleton + HTTP fallthrough

**Files:**
- Create: `packages/hub/src/ws/server.ts`, `packages/hub/src/ws/server.test.ts`

The hub serves both the SPA static assets (HTTP) and the WS protocol on the same port.

- [ ] **Step 1: Test**

  ```typescript
  // packages/hub/src/ws/server.test.ts
  import { describe, it, expect, beforeEach, afterEach } from 'vitest';
  import WebSocket from 'ws';
  import { createWsServer, type WsServerInstance } from './server.js';
  import { SessionRegistry } from '../registry/session-registry.js';
  import { EventBus } from '../event-bus.js';
  import { PtyTap } from '../observers/pty-tap.js';

  let svr: WsServerInstance; let port: number;
  beforeEach(async () => {
    svr = createWsServer({ registry: new SessionRegistry(), bus: new EventBus(), tap: new PtyTap({ ringBytes: 1024 }), staticDir: null });
    await svr.listen(0, '127.0.0.1');
    port = svr.address().port;
  });
  afterEach(async () => { await svr.close(); });

  describe('WS server', () => {
    it('accepts a WS connection on /v1/ws', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`);
      await new Promise<void>((resolve, reject) => {
        ws.on('open', resolve); ws.on('error', reject);
      });
      ws.close();
    });
    it('responds 426 when WS upgrade is missing on /v1/ws', async () => {
      const r = await fetch(`http://127.0.0.1:${port}/v1/ws`);
      expect(r.status).toBe(426);
    });
    it('returns 404 for HTTP paths when no static dir is configured', async () => {
      const r = await fetch(`http://127.0.0.1:${port}/`);
      expect(r.status).toBe(404);
    });
  });
  ```

- [ ] **Step 2: Implement**

  ```typescript
  // packages/hub/src/ws/server.ts
  import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
  import { WebSocketServer, type WebSocket } from 'ws';
  import { readFileSync, existsSync, statSync } from 'node:fs';
  import { join, normalize, resolve, extname } from 'node:path';
  import { AddressInfo } from 'node:net';
  import type { SessionRegistry } from '../registry/session-registry.js';
  import type { EventBus } from '../event-bus.js';
  import type { PtyTap } from '../observers/pty-tap.js';
  import { handleConnection } from './connection.js';

  export interface WsServerDeps {
    registry: SessionRegistry;
    bus:      EventBus;
    tap:      PtyTap;
    staticDir: string | null;
    /** Called when a WS client sends an input.action or input.text. Wired in T38. */
    onInput?: (sessionId: string, data: string, source: string) => Promise<{ ok: boolean; reason?: string }>;
  }

  export interface WsServerInstance {
    listen(port: number, host: string): Promise<void>;
    close(): Promise<void>;
    address(): AddressInfo;
    broadcast(msg: object, filter?: (clientCaps: string[]) => boolean): void;
  }

  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.svg':  'image/svg+xml',
    '.json': 'application/json; charset=utf-8',
    '.ico':  'image/x-icon',
  };

  export function createWsServer(deps: WsServerDeps): WsServerInstance {
    const http = createServer((req, res) => serveHttp(req, res, deps));
    const wss = new WebSocketServer({ noServer: true });
    const sockets = new Set<WebSocket>();

    http.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname !== '/v1/ws') {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        sockets.add(ws);
        ws.on('close', () => sockets.delete(ws));
        handleConnection(ws, deps);
      });
    });

    return {
      listen: (port, host) => new Promise((resolve, reject) => {
        http.once('error', reject);
        http.listen(port, host, () => { http.off('error', reject); resolve(); });
      }),
      close: () => new Promise((resolve) => {
        for (const ws of sockets) ws.terminate();
        wss.close(() => http.close(() => resolve()));
      }),
      address: () => http.address() as AddressInfo,
      broadcast: (msg, filter) => {
        const data = JSON.stringify(msg);
        for (const ws of sockets) {
          // (filter is applied per-connection in T36 once capabilities are stored on the connection.)
          if ((ws as any).readyState === 1) ws.send(data);
        }
      },
    };
  }

  function serveHttp(req: IncomingMessage, res: ServerResponse, deps: WsServerDeps): void {
    if ((req.url ?? '').startsWith('/v1/ws')) return void res.writeHead(426).end('Upgrade Required');
    if (!deps.staticDir) return void res.writeHead(404).end();
    const url = new URL(req.url ?? '/', 'http://x');
    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const safePath = normalize(join(deps.staticDir, requested));
    if (!safePath.startsWith(resolve(deps.staticDir))) return void res.writeHead(403).end();
    if (!existsSync(safePath) || !statSync(safePath).isFile()) return void res.writeHead(404).end();
    const ext = extname(safePath);
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
    res.end(readFileSync(safePath));
  }
  ```

- [ ] **Step 3: Stub `connection.ts` so the test compiles**

  ```typescript
  // packages/hub/src/ws/connection.ts
  import type { WebSocket } from 'ws';
  import type { WsServerDeps } from './server.js';

  export function handleConnection(ws: WebSocket, _deps: WsServerDeps): void {
    // T35 fills in; for now just close on any message.
    ws.on('message', () => ws.close(1011, 'not yet implemented'));
  }
  ```

- [ ] **Step 4: Run, expect pass + Commit**

  ```bash
  pnpm test
  git add packages/hub/src/ws/
  git commit -m "hub: WS server skeleton + static asset serving"
  ```

### Task 35: client.identify + server.hello + capability tracking

**Files:**
- Modify: `packages/hub/src/ws/connection.ts`
- Create: `packages/hub/src/ws/connection.test.ts`

- [ ] **Step 1: Test**

  ```typescript
  // packages/hub/src/ws/connection.test.ts
  import { describe, it, expect, beforeEach, afterEach } from 'vitest';
  import WebSocket from 'ws';
  import { createWsServer, type WsServerInstance } from './server.js';
  import { SessionRegistry } from '../registry/session-registry.js';
  import { EventBus } from '../event-bus.js';
  import { PtyTap } from '../observers/pty-tap.js';

  let svr: WsServerInstance; let port: number;
  beforeEach(async () => {
    svr = createWsServer({ registry: new SessionRegistry(), bus: new EventBus(), tap: new PtyTap({ ringBytes: 1024 }), staticDir: null });
    await svr.listen(0, '127.0.0.1'); port = svr.address().port;
  });
  afterEach(async () => { await svr.close(); });

  function open(): WebSocket {
    return new WebSocket(`ws://127.0.0.1:${port}/v1/ws`);
  }

  function recvFirst(ws: WebSocket): Promise<any> {
    return new Promise((resolve, reject) => {
      ws.once('message', (m) => resolve(JSON.parse(m.toString())));
      ws.once('error', reject);
    });
  }

  describe('client.identify handshake', () => {
    it('responds with server.hello after valid client.identify', async () => {
      const ws = await new Promise<WebSocket>((res, rej) => {
        const w = open(); w.on('open', () => res(w)); w.on('error', rej);
      });
      ws.send(JSON.stringify({
        type: 'client.identify', protocol: 1,
        client: { kind: 'debug-web', version: '0.0.0', capabilities: ['summary','events','state'] },
      }));
      const reply = await recvFirst(ws);
      expect(reply.type).toBe('server.hello');
      expect(reply.protocol).toBe(1);
      ws.close();
    });
    it('closes 1002 if first frame is not client.identify', async () => {
      const ws = await new Promise<WebSocket>((res, rej) => {
        const w = open(); w.on('open', () => res(w)); w.on('error', rej);
      });
      const closed = new Promise<{ code: number }>((res) => ws.on('close', (code) => res({ code })));
      ws.send(JSON.stringify({ type: 'subscribe', sessions: 'all', since: null }));
      const r = await closed;
      expect(r.code).toBe(1002);
    });
    it('closes 1002 if client.identify is malformed', async () => {
      const ws = await new Promise<WebSocket>((res, rej) => {
        const w = open(); w.on('open', () => res(w)); w.on('error', rej);
      });
      const closed = new Promise<{ code: number }>((res) => ws.on('close', (code) => res({ code })));
      ws.send(JSON.stringify({ type: 'client.identify', protocol: 99 }));
      const r = await closed;
      expect(r.code).toBe(1002);
    });
  });
  ```

- [ ] **Step 2: Implement `connection.ts`**

  ```typescript
  // packages/hub/src/ws/connection.ts
  import type { WebSocket } from 'ws';
  import type { WsServerDeps } from './server.js';
  import { ClientIdentifySchema, UpstreamMessageSchema, PROTOCOL_VERSION } from '@sesshin/shared';
  import { hostname } from 'node:os';

  export interface ConnectionState {
    ws: WebSocket;
    kind: string | null;
    capabilities: Set<string>;
    subscribedTo: Set<string> | 'all';
  }

  export function handleConnection(ws: WebSocket, deps: WsServerDeps): void {
    const state: ConnectionState = { ws, kind: null, capabilities: new Set(), subscribedTo: new Set() };
    let identified = false;
    const identifyTimeout = setTimeout(() => {
      if (!identified) ws.close(1002, 'no client.identify within 5s');
    }, 5000);

    ws.on('message', (raw) => {
      let parsed: unknown;
      try { parsed = JSON.parse(raw.toString()); }
      catch { ws.close(1002, 'bad-frame'); return; }

      if (!identified) {
        const idResult = ClientIdentifySchema.safeParse(parsed);
        if (!idResult.success) { ws.close(1002, 'bad-identify'); return; }
        identified = true;
        clearTimeout(identifyTimeout);
        state.kind = idResult.data.client.kind;
        state.capabilities = new Set(idResult.data.client.capabilities);
        ws.send(JSON.stringify({
          type: 'server.hello', protocol: PROTOCOL_VERSION,
          machine: hostname(),
          supported: ['summary','events','raw','actions','voice','history','state','attention'],
        }));
        // Future: T36 hooks subsequent message handling here.
        attachSubscribed(state, deps);
        return;
      }

      const upstream = UpstreamMessageSchema.safeParse(parsed);
      if (!upstream.success) {
        ws.send(JSON.stringify({ type: 'server.error', code: 'bad-frame' }));
        ws.close();
        return;
      }
      handleUpstream(state, upstream.data, deps);
    });
  }

  // Stubs that T36/T38 fill in. Provided here so the file type-checks.
  function attachSubscribed(_state: ConnectionState, _deps: WsServerDeps): void { /* T36 */ }
  function handleUpstream(_state: ConnectionState, _msg: unknown, _deps: WsServerDeps): void { /* T36/T38 */ }
  ```

- [ ] **Step 3: Run + commit**

  ```bash
  pnpm test
  git add packages/hub/src/ws/
  git commit -m "hub: WS client.identify handshake + server.hello"
  ```

### Task 36: subscribe + session.list + per-connection broadcast

**Files:**
- Modify: `packages/hub/src/ws/connection.ts`, `packages/hub/src/ws/server.ts`
- Create: `packages/hub/src/ws/broadcast.test.ts`

- [ ] **Step 1: Test**

  ```typescript
  // packages/hub/src/ws/broadcast.test.ts
  import { describe, it, expect, beforeEach, afterEach } from 'vitest';
  import WebSocket from 'ws';
  import { createWsServer, type WsServerInstance } from './server.js';
  import { SessionRegistry } from '../registry/session-registry.js';
  import { EventBus } from '../event-bus.js';
  import { PtyTap } from '../observers/pty-tap.js';

  let svr: WsServerInstance; let port: number; let registry: SessionRegistry; let bus: EventBus; let tap: PtyTap;
  beforeEach(async () => {
    registry = new SessionRegistry();
    bus = new EventBus();
    tap = new PtyTap({ ringBytes: 1024 });
    svr = createWsServer({ registry, bus, tap, staticDir: null });
    await svr.listen(0, '127.0.0.1'); port = svr.address().port;
  });
  afterEach(async () => { await svr.close(); });

  async function connect(caps: string[]): Promise<{ ws: WebSocket; recv: () => Promise<any[]> }> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`);
    await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
    const messages: any[] = [];
    ws.on('message', (m) => messages.push(JSON.parse(m.toString())));
    ws.send(JSON.stringify({ type: 'client.identify', protocol: 1, client: { kind: 'debug-web', version: '0', capabilities: caps } }));
    await new Promise<void>((res) => setTimeout(res, 50));
    return { ws, recv: async () => { await new Promise<void>((res) => setTimeout(res, 50)); return messages.slice(); } };
  }

  describe('subscribe + broadcast', () => {
    it('returns session.list snapshot on subscribe', async () => {
      registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
      const { ws, recv } = await connect(['state','events']);
      ws.send(JSON.stringify({ type: 'subscribe', sessions: 'all', since: null }));
      const messages = await recv();
      const list = messages.find((m) => m.type === 'session.list');
      expect(list).toBeTruthy();
      expect(list.sessions).toHaveLength(1);
      ws.close();
    });
    it('drops session.summary if client did not declare summary capability', async () => {
      registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
      const { ws, recv } = await connect(['state']);  // no `summary`
      ws.send(JSON.stringify({ type: 'subscribe', sessions: 'all', since: null }));
      svr.broadcast({ type: 'session.summary', sessionId: 's1', summaryId: 'sum-1', oneLine: 'x', bullets: [], needsDecision: false, suggestedNext: null, since: null, generatedAt: 1, generatorModel: 'claude-haiku' });
      const messages = await recv();
      expect(messages.find((m) => m.type === 'session.summary')).toBeUndefined();
      ws.close();
    });
  });
  ```

- [ ] **Step 2: Update `connection.ts`**

  Replace the previous `attachSubscribed` and `handleUpstream` stubs:

  ```typescript
  import { SessionInfoSchema } from '@sesshin/shared';

  function attachSubscribed(state: ConnectionState, deps: WsServerDeps): void {
    // Listen for registry changes and forward to this client when subscribed.
    const onAdded = (s: any): void => {
      if (!isSubscribed(state, s.id) || !state.capabilities.has('state')) return;
      state.ws.send(JSON.stringify({ type: 'session.added', session: s }));
    };
    const onRemoved = (id: string): void => {
      if (!isSubscribed(state, id) || !state.capabilities.has('state')) return;
      state.ws.send(JSON.stringify({ type: 'session.removed', sessionId: id }));
    };
    const onState = (s: any): void => {
      if (!isSubscribed(state, s.id) || !state.capabilities.has('state')) return;
      state.ws.send(JSON.stringify({ type: 'session.state', sessionId: s.id, state: s.state, substate: s.substate }));
    };
    deps.registry.on('session-added', onAdded);
    deps.registry.on('session-removed', onRemoved);
    deps.registry.on('state-changed', onState);
    deps.registry.on('substate-changed', onState);

    const onEvent = (e: any): void => {
      if (!isSubscribed(state, e.sessionId)) return;
      if (!state.capabilities.has('events') && e.kind !== 'agent-output') return;
      state.ws.send(JSON.stringify({ type: 'session.event', ...e }));
    };
    deps.bus.on(onEvent);

    state.ws.on('close', () => {
      deps.registry.off('session-added', onAdded);
      deps.registry.off('session-removed', onRemoved);
      deps.registry.off('state-changed', onState);
      deps.registry.off('substate-changed', onState);
      deps.bus.off(onEvent);
    });
  }

  function isSubscribed(state: ConnectionState, sessionId: string): boolean {
    if (state.subscribedTo === 'all') return true;
    return state.subscribedTo.has(sessionId);
  }

  function handleUpstream(state: ConnectionState, msg: any, deps: WsServerDeps): void {
    if (msg.type === 'subscribe') {
      state.subscribedTo = msg.sessions === 'all' ? 'all' : new Set(msg.sessions);
      state.ws.send(JSON.stringify({ type: 'session.list', sessions: deps.registry.list() }));
      // (since-replay handled in T37.)
      return;
    }
    if (msg.type === 'unsubscribe') {
      if (state.subscribedTo === 'all') state.subscribedTo = new Set();
      else for (const id of msg.sessions) state.subscribedTo.delete(id);
      return;
    }
    // Other types (input.action / input.text) — T38.
  }
  ```

- [ ] **Step 3: Update `server.ts` `broadcast` to honor capability filtering on summary/raw**

  Replace `broadcast` body in `server.ts` so it uses per-connection state (we now track the connection's state via the Set of sockets):

  Actually the cleaner refactor: register each connection's send-with-caps function in a list and iterate that. Restructure `server.ts`:

  ```typescript
  // In createWsServer, replace the sockets Set + broadcast with a list of "broadcast targets":
  const targets = new Set<{ ws: WebSocket; caps: () => Set<string>; subbed: () => Set<string> | 'all' }>();
  // Pass `targets` to handleConnection so it can register/unregister itself.
  ```

  Then implement `broadcast` to filter by message-type-required-capability:

  ```typescript
  function capabilityRequiredFor(msgType: string): string | null {
    switch (msgType) {
      case 'session.summary':   return 'summary';
      case 'session.raw':       return 'raw';
      case 'session.event':     return 'events';
      case 'session.attention': return 'attention';
      case 'session.state':
      case 'session.list':
      case 'session.added':
      case 'session.removed':   return 'state';
      default:                  return null;
    }
  }
  ```

  Apply this filter in the `broadcast` method by iterating `targets` and skipping when the cap is missing.

- [ ] **Step 4: Run, expect pass + Commit**

  ```bash
  pnpm test
  git add packages/hub/src/ws/
  git commit -m "hub: WS subscribe + session.list + capability-gated broadcast"
  ```

### Task 37: Reconnect with `since` event replay

**Files:**
- Modify: `packages/hub/src/event-bus.ts` (event-id memory ring), `packages/hub/src/ws/connection.ts`
- Modify: `packages/hub/src/ws/broadcast.test.ts` (add a since-replay scenario)

- [ ] **Step 1: Add a small history ring to EventBus**

  ```typescript
  // In event-bus.ts, add a bounded recent-events ring keyed by sessionId.
  export class EventBus {
    private listeners = new Set<Listener>();
    private recent = new Map<string, NormalizedEvent[]>();
    private readonly maxPerSession = 200;

    on(fn: Listener): void { this.listeners.add(fn); }
    off(fn: Listener): void { this.listeners.delete(fn); }
    emit(e: NormalizedEvent): void {
      let arr = this.recent.get(e.sessionId);
      if (!arr) { arr = []; this.recent.set(e.sessionId, arr); }
      arr.push(e);
      if (arr.length > this.maxPerSession) arr.shift();
      for (const fn of this.listeners) fn(e);
    }
    /** Return events for a session strictly after the given eventId (or all if eventId is unknown / null). */
    eventsSince(sessionId: string, eventId: string | null): NormalizedEvent[] {
      const arr = this.recent.get(sessionId) ?? [];
      if (!eventId) return arr.slice();
      const idx = arr.findIndex((e) => e.eventId === eventId);
      return idx >= 0 ? arr.slice(idx + 1) : arr.slice();
    }
  }
  ```

  Adjust the existing test so the new `eventsSince` is also covered:

  ```typescript
  // append to packages/hub/src/event-bus.test.ts
  it('eventsSince(sessionId, null) returns all recent', () => {
    const bus = new EventBus();
    bus.emit({ eventId: 'e1', sessionId: 's', kind: 'tool-call', payload: {}, source: 'observer:hook-ingest', ts: 1 });
    bus.emit({ eventId: 'e2', sessionId: 's', kind: 'tool-result', payload: {}, source: 'observer:hook-ingest', ts: 2 });
    expect(bus.eventsSince('s', null)).toHaveLength(2);
  });
  it('eventsSince filters strictly after the given id', () => {
    const bus = new EventBus();
    bus.emit({ eventId: 'e1', sessionId: 's', kind: 'tool-call', payload: {}, source: 'observer:hook-ingest', ts: 1 });
    bus.emit({ eventId: 'e2', sessionId: 's', kind: 'tool-result', payload: {}, source: 'observer:hook-ingest', ts: 2 });
    expect(bus.eventsSince('s', 'e1').map((e) => e.eventId)).toEqual(['e2']);
  });
  ```

- [ ] **Step 2: Use it in `subscribe` handler**

  In `connection.ts` `handleUpstream` `subscribe` branch, after sending `session.list`:

  ```typescript
  if (msg.since && state.capabilities.has('events')) {
    const sids = state.subscribedTo === 'all' ? deps.registry.list().map((s) => s.id) : Array.from(state.subscribedTo);
    for (const sid of sids) {
      for (const e of deps.bus.eventsSince(sid, msg.since)) {
        state.ws.send(JSON.stringify({ type: 'session.event', ...e }));
      }
    }
  }
  ```

- [ ] **Step 3: Run + commit**

  ```bash
  pnpm test
  git add packages/hub/src/
  git commit -m "hub: WS subscribe replays events since lastEventId"
  ```

### Task 38: Input arbiter + `/api/sessions/:id/inject` + WS input.action / input.text

**Files:**
- Create: `packages/hub/src/input-arbiter.ts`, `packages/hub/src/input-arbiter.test.ts`
- Create: `packages/hub/src/agents/claude/action-map.ts`, `packages/hub/src/agents/claude/action-map.test.ts`
- Modify: `packages/hub/src/rest/server.ts` (add `/api/sessions/:id/inject`)
- Modify: `packages/hub/src/ws/connection.ts` (handle input.action / input.text)

- [ ] **Step 1: Test input-arbiter (state-vs-source matrix)**

  ```typescript
  // packages/hub/src/input-arbiter.test.ts
  import { describe, it, expect } from 'vitest';
  import { canAcceptInput } from './input-arbiter.js';

  describe('canAcceptInput', () => {
    it('laptop input always allowed', () => {
      for (const s of ['idle','running','awaiting-input','awaiting-confirmation','error'] as const) {
        expect(canAcceptInput(s, 'laptop').ok).toBe(true);
      }
    });
    it('remote input allowed when state is idle/awaiting-*', () => {
      for (const s of ['idle','awaiting-input','awaiting-confirmation'] as const) {
        expect(canAcceptInput(s, 'remote-adapter:debug-web').ok).toBe(true);
      }
    });
    it('remote input rejected during running', () => {
      expect(canAcceptInput('running', 'remote-adapter:debug-web')).toEqual({ ok: false, reason: 'running' });
    });
    it('remote input rejected when state is done/interrupted', () => {
      expect(canAcceptInput('done', 'remote-adapter:debug-web')).toEqual({ ok: false, reason: 'session-offline' });
      expect(canAcceptInput('interrupted', 'remote-adapter:debug-web')).toEqual({ ok: false, reason: 'session-offline' });
    });
  });
  ```

- [ ] **Step 2: Implement input-arbiter**

  ```typescript
  // packages/hub/src/input-arbiter.ts
  import type { SessionState } from '@sesshin/shared';

  export type InputSource = 'laptop' | `remote-adapter:${string}`;
  export type AcceptResult = { ok: true } | { ok: false; reason: string };

  export function canAcceptInput(state: SessionState, source: InputSource): AcceptResult {
    if (source === 'laptop') return { ok: true };
    if (state === 'idle' || state === 'awaiting-input' || state === 'awaiting-confirmation') return { ok: true };
    if (state === 'running') return { ok: false, reason: 'running' };
    if (state === 'starting' || state === 'error') return { ok: true };
    return { ok: false, reason: 'session-offline' };  // done, interrupted
  }
  ```

- [ ] **Step 3: Test action map**

  ```typescript
  // packages/hub/src/agents/claude/action-map.test.ts
  import { describe, it, expect } from 'vitest';
  import { actionToInput } from './action-map.js';

  describe('actionToInput (claude)', () => {
    it('approve → "y\\n"', () => { expect(actionToInput('approve')).toBe('y\n'); });
    it('reject → "n\\n"', () => { expect(actionToInput('reject')).toBe('n\n'); });
    it('continue → "\\n"', () => { expect(actionToInput('continue')).toBe('\n'); });
    it('stop → ESC (\\x1b)', () => { expect(actionToInput('stop')).toBe('\x1b'); });
    it('retry → "/retry\\n"', () => { expect(actionToInput('retry')).toBe('/retry\n'); });
  });
  ```

- [ ] **Step 4: Implement action map (initial mapping; refine after gate 4 informs us)**

  ```typescript
  // packages/hub/src/agents/claude/action-map.ts
  import type { Action } from '@sesshin/shared';

  export function actionToInput(action: Action): string | null {
    switch (action) {
      case 'approve':   return 'y\n';
      case 'reject':    return 'n\n';
      case 'continue':  return '\n';
      case 'stop':      return '\x1b';      // ESC
      case 'retry':     return '/retry\n';
      case 'fix':       return '/fix\n';
      case 'summarize': return '/summarize\n';
      case 'details':   return '/details\n';
      case 'ignore':    return '';
      case 'snooze':    return '';
      default:          return null;
    }
  }
  ```

- [ ] **Step 5: Add `/api/sessions/:id/inject` to REST**

  In `packages/hub/src/rest/server.ts`:

  ```typescript
  // Body schema near the others
  const InjectBody = z.object({ data: z.string(), source: z.string() });

  // Route handler — add inside `route`:
  const inj = url.pathname.match(/^\/api\/sessions\/([^/]+)\/inject$/);
  if (inj) {
    const id = inj[1]!;
    if (method !== 'POST') return void res.writeHead(405).end();
    if (!deps.registry.get(id)) return void res.writeHead(404).end();
    let body: unknown;
    try { body = await readJson(req); } catch { return void res.writeHead(400).end(); }
    const parsed = InjectBody.safeParse(body);
    if (!parsed.success) return void res.writeHead(400).end();
    const ok = await deps.onInjectFromHub?.(id, parsed.data.data, parsed.data.source);
    return void res.writeHead(ok ? 204 : 502).end();
  }
  ```

  Add to `RestServerDeps`:

  ```typescript
  /** Called when the hub itself wants to push input back into the CLI. Wired in T56 (the CLI long-polls for these via WS in v1). */
  onInjectFromHub?: (sessionId: string, data: string, source: string) => Promise<boolean>;
  ```

  In v1, since the CLI subscribes to a WS channel for inject, this REST endpoint is mainly for tests / debugging — the hub itself uses an in-process call when delivering input. We still expose the route for completeness.

- [ ] **Step 6: Wire WS `input.action` / `input.text` to the arbiter**

  In `packages/hub/src/ws/connection.ts` `handleUpstream`:

  ```typescript
  import { canAcceptInput } from '../input-arbiter.js';
  import { actionToInput } from '../agents/claude/action-map.js';

  // Inside handleUpstream:
  if (msg.type === 'input.action' || msg.type === 'input.text') {
    const session = deps.registry.get(msg.sessionId);
    if (!session) {
      state.ws.send(JSON.stringify({ type: 'server.error', code: 'input-rejected', message: 'session-offline' }));
      return;
    }
    const source = `remote-adapter:${state.kind ?? 'unknown'}` as const;
    const decision = canAcceptInput(session.state, source);
    if (!decision.ok) {
      state.ws.send(JSON.stringify({ type: 'server.error', code: 'input-rejected', message: decision.reason }));
      return;
    }
    let data: string | null = null;
    if (msg.type === 'input.text') data = msg.text;
    else if (session.agent === 'claude-code') data = actionToInput(msg.action);
    if (!data) {
      state.ws.send(JSON.stringify({ type: 'server.error', code: 'unsupported-action' }));
      return;
    }
    deps.onInput?.(msg.sessionId, data, source).catch(() => {});
  }
  ```

  Add `onInput` to `WsServerDeps` (already declared in T34 as a placeholder).

- [ ] **Step 7: Run + commit**

  ```bash
  pnpm test
  git add packages/hub/src/
  git commit -m "hub: input arbiter + Claude action map + WS input handlers + REST /inject"
  ```

### Task 39: Wire input-injection bridge into hub composition

**Files:**
- Modify: `packages/hub/src/wire.ts`
- Create: `packages/hub/src/input-bridge.ts`, `packages/hub/src/input-bridge.test.ts`

The hub holds a per-session listener that the CLI subscribes to over WS using a special `m5stick`-style adapter kind reserved for the CLI. For v1 we simplify: the hub keeps a per-session callback registry; when the CLI registers, it also opens a WS connection identifying as `kind: "other"` with `capabilities: ["actions"]` and a special `client.role: "cli"` field — this is our internal bus for delivering input back to the CLI. Implementation detail kept simple.

- [ ] **Step 1: `packages/hub/src/input-bridge.ts`**

  ```typescript
  type Sink = (data: string, source: string) => Promise<void>;

  export class InputBridge {
    private sinks = new Map<string, Sink>();

    setSink(sessionId: string, sink: Sink): void { this.sinks.set(sessionId, sink); }
    clearSink(sessionId: string): void { this.sinks.delete(sessionId); }

    async deliver(sessionId: string, data: string, source: string): Promise<{ ok: boolean; reason?: string }> {
      const sink = this.sinks.get(sessionId);
      if (!sink) return { ok: false, reason: 'session-offline' };
      try { await sink(data, source); return { ok: true }; }
      catch { return { ok: false, reason: 'sink-error' }; }
    }
  }
  ```

- [ ] **Step 2: Test**

  ```typescript
  // packages/hub/src/input-bridge.test.ts
  import { describe, it, expect } from 'vitest';
  import { InputBridge } from './input-bridge.js';

  describe('InputBridge', () => {
    it('deliver invokes the registered sink', async () => {
      const b = new InputBridge();
      const calls: any[] = [];
      b.setSink('s1', async (d, s) => { calls.push([d, s]); });
      const r = await b.deliver('s1', 'y\n', 'remote-adapter:web');
      expect(r.ok).toBe(true);
      expect(calls).toEqual([['y\n','remote-adapter:web']]);
    });
    it('reports session-offline when no sink', async () => {
      const b = new InputBridge();
      const r = await b.deliver('missing', 'x', 'laptop');
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('session-offline');
    });
  });
  ```

- [ ] **Step 3: Update `wire.ts` to construct + pass the bridge**

  ```typescript
  // In wire.ts, add:
  import { InputBridge } from './input-bridge.js';
  import { createWsServer } from './ws/server.js';
  // ...
  const bridge = new InputBridge();
  // REST server gets the bridge:
  const rest = createRestServer({
    registry, tap, onHookEvent,
    onInjectFromHub: (id, data, source) => bridge.deliver(id, data, source).then((r) => r.ok),
  });
  // WS server gets the bridge as the input sink:
  const ws = createWsServer({
    registry, bus: dedupedBus, tap, staticDir: null,
    onInput: async (sessionId, data, source) => {
      const r = await bridge.deliver(sessionId, data, source);
      return { ok: r.ok, ...(r.reason ? { reason: r.reason } : {}) };
    },
  });
  await ws.listen(config.publicPort, config.publicHost);
  // Expose bridge in the HubInstance so the CLI can register via internal mechanism (T55).
  return { ...prior, ws, bridge, shutdown: async () => { ... await ws.close(); } };
  ```

  (The CLI will publish its sink later via a dedicated REST endpoint — added in T56 — that calls `bridge.setSink(sessionId, fn)`.)

- [ ] **Step 4: Add a thin REST endpoint to receive sink registration from CLI**

  In `packages/hub/src/rest/server.ts`, add to `RestServerDeps`:

  ```typescript
  onAttachSink?: (sessionId: string, deliver: (data: string, source: string) => Promise<void>) => void;
  ```

  And in the route table, accept a streaming POST to `/api/sessions/:id/sink-stream` that holds the connection open and serializes any `{data, source}` message the hub wants to deliver as a JSONL response. (The CLI keeps the stream open for the lifetime of the session and reads from it.)

  ```typescript
  const sink = url.pathname.match(/^\/api\/sessions\/([^/]+)\/sink-stream$/);
  if (sink) {
    const id = sink[1]!;
    if (method !== 'POST') return void res.writeHead(405).end();
    if (!deps.registry.get(id)) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' });
    deps.onAttachSink?.(id, async (data, source) => {
      res.write(JSON.stringify({ data, source }) + '\n');
    });
    req.on('close', () => { /* T55 cleanup hook */ });
    return;
  }
  ```

  Wire `onAttachSink` in `wire.ts` to call `bridge.setSink(...)`.

- [ ] **Step 5: Run + commit**

  ```bash
  pnpm test
  git add packages/hub/src/
  git commit -m "hub: InputBridge + sink-stream endpoint for CLI<->hub input delivery"
  ```

### Task 40: M5 milestone checkpoint + smoke

- [ ] **Step 1: All tests pass**

  ```bash
  pnpm test
  ```

- [ ] **Step 2: End-to-end smoke without summarizer**

  ```bash
  cd packages/hub && pnpm build
  node dist/main.js &
  HUB_PID=$!
  sleep 0.5
  curl -s http://127.0.0.1:9663/api/health
  echo
  # Open a WS connection from the CLI, send identify, see server.hello.
  node -e "
    import('ws').then(({ default: WS }) => {
      const ws = new WS('ws://127.0.0.1:9662/v1/ws');
      ws.on('open', () => ws.send(JSON.stringify({ type:'client.identify', protocol:1, client:{ kind:'debug-web', version:'0', capabilities:['state','events'] } })));
      ws.on('message', (m) => { console.log(String(m)); ws.close(); });
    });
  "
  kill $HUB_PID
  ```

  Expected: prints a `server.hello` JSON.

- [ ] **Step 3: Tag**

  ```bash
  git tag M5
  ```

---

## Milestone M6: Summarizer (Mode B′ + Mode B + heuristic)

The hot path is Mode B′. Code lifts directly from `prototypes/mode-b-prime.mjs` with TypeScript types and a clean separation between "read credentials," "refresh if needed," "build request," "call API."

### Task 41: Claude credentials reader + atomic writer

**Files:**
- Create: `packages/hub/src/agents/claude/credentials.ts`, `packages/hub/src/agents/claude/credentials.test.ts`

- [ ] **Step 1: Test**

  ```typescript
  // packages/hub/src/agents/claude/credentials.test.ts
  import { describe, it, expect, beforeEach, afterEach } from 'vitest';
  import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';
  import { readClaudeCredentials, writeClaudeCredentialsAtomic } from './credentials.js';

  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cc-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  describe('credentials', () => {
    it('reads claudeAiOauth wrapper', () => {
      const p = join(dir, 'cred.json');
      writeFileSync(p, JSON.stringify({
        claudeAiOauth: {
          accessToken: 'a', refreshToken: 'r', expiresAt: 100, scopes: ['s'],
          subscriptionType: 'max', rateLimitTier: 'tier',
        },
        mcpOAuth: {},
      }));
      const c = readClaudeCredentials(p);
      expect(c?.accessToken).toBe('a');
      expect(c?.refreshToken).toBe('r');
      expect(c?.expiresAt).toBe(100);
    });
    it('returns null when file missing', () => {
      expect(readClaudeCredentials(join(dir, 'absent.json'))).toBeNull();
    });
    it('atomic write preserves 0600 mode and other top-level keys', () => {
      const p = join(dir, 'cred.json');
      writeFileSync(p, JSON.stringify({
        claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 1, scopes: ['s'], subscriptionType: 'pro', rateLimitTier: 'x' },
        mcpOAuth: { foo: { bar: 1 } },
      }), { mode: 0o600 });
      writeClaudeCredentialsAtomic(p, {
        accessToken: 'A2', refreshToken: 'R2', expiresAt: 999, scopes: ['s'], subscriptionType: 'pro', rateLimitTier: 'x',
      });
      const after = JSON.parse(readFileSync(p, 'utf-8'));
      expect(after.claudeAiOauth.accessToken).toBe('A2');
      expect(after.mcpOAuth).toEqual({ foo: { bar: 1 } });   // untouched
      expect(statSync(p).mode & 0o777).toBe(0o600);
    });
  });
  ```

- [ ] **Step 2: Implement**

  ```typescript
  // packages/hub/src/agents/claude/credentials.ts
  import { readFileSync, writeFileSync, renameSync, existsSync, statSync } from 'node:fs';
  import { dirname } from 'node:path';

  export interface ClaudeOAuth {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes: string[];
    subscriptionType: string;
    rateLimitTier: string;
  }

  export function readClaudeCredentials(path: string): ClaudeOAuth | null {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf-8');
    const j = JSON.parse(raw);
    if (!j.claudeAiOauth) return null;
    const o = j.claudeAiOauth;
    return {
      accessToken: o.accessToken,
      refreshToken: o.refreshToken,
      expiresAt: o.expiresAt,
      scopes: o.scopes ?? [],
      subscriptionType: o.subscriptionType ?? '',
      rateLimitTier: o.rateLimitTier ?? '',
    };
  }

  export function writeClaudeCredentialsAtomic(path: string, oauth: ClaudeOAuth): void {
    // Preserve any other top-level keys (notably mcpOAuth).
    let envelope: any = { claudeAiOauth: {}, mcpOAuth: {} };
    if (existsSync(path)) {
      try { envelope = JSON.parse(readFileSync(path, 'utf-8')); } catch { /* fallthrough with empty */ }
    }
    envelope.claudeAiOauth = {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt,
      scopes: oauth.scopes,
      subscriptionType: oauth.subscriptionType,
      rateLimitTier: oauth.rateLimitTier,
    };
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(envelope, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  }
  ```

- [ ] **Step 3: Run + commit**

  ```bash
  pnpm test
  git add packages/hub/src/agents/claude/credentials.ts packages/hub/src/agents/claude/credentials.test.ts
  git commit -m "hub: Claude credentials reader + atomic writer (preserves mcpOAuth)"
  ```

### Task 42: OAuth refresh

**Files:**
- Create: `packages/hub/src/agents/claude/refresh-oauth.ts`, `packages/hub/src/agents/claude/refresh-oauth.test.ts`

- [ ] **Step 1: Test (uses msw to intercept the refresh URL)**

  ```typescript
  // packages/hub/src/agents/claude/refresh-oauth.test.ts
  import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
  import { setupServer } from 'msw/node';
  import { http, HttpResponse } from 'msw';
  import { refreshClaudeOAuth } from './refresh-oauth.js';

  let lastBody: any = null;
  const server = setupServer(
    http.post('https://console.anthropic.com/v1/oauth/token', async ({ request }) => {
      lastBody = await request.json();
      return HttpResponse.json({
        access_token: 'NEW_A', refresh_token: 'NEW_R', expires_in: 3600,
      });
    }),
  );
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => { server.resetHandlers(); lastBody = null; });
  afterAll(() => server.close());

  describe('refreshClaudeOAuth', () => {
    it('POSTs grant_type=refresh_token + refresh_token + client_id', async () => {
      const r = await refreshClaudeOAuth({ refreshToken: 'OLD_R' });
      expect(r.accessToken).toBe('NEW_A');
      expect(r.refreshToken).toBe('NEW_R');
      expect(r.expiresAt).toBeGreaterThan(Date.now());
      expect(lastBody.grant_type).toBe('refresh_token');
      expect(lastBody.refresh_token).toBe('OLD_R');
      expect(lastBody.client_id).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
    });
    it('throws on non-2xx', async () => {
      server.use(http.post('https://console.anthropic.com/v1/oauth/token', () => HttpResponse.text('nope', { status: 401 })));
      await expect(refreshClaudeOAuth({ refreshToken: 'x' })).rejects.toThrow();
    });
  });
  ```

- [ ] **Step 2: Implement**

  ```typescript
  // packages/hub/src/agents/claude/refresh-oauth.ts
  const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
  const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
  const USER_AGENT_PREFIX = 'claude-cli';

  export interface RefreshResult {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  }

  export async function refreshClaudeOAuth(opts: { refreshToken: string; userAgent?: string }): Promise<RefreshResult> {
    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': opts.userAgent ?? `${USER_AGENT_PREFIX}/2.1.126 (external, cli)`,
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: opts.refreshToken,
        client_id: CLIENT_ID,
      }),
    });
    if (!r.ok) throw new Error(`refresh failed: ${r.status} ${await r.text()}`);
    const j = await r.json() as { access_token: string; refresh_token?: string; expires_in?: number };
    return {
      accessToken: j.access_token,
      refreshToken: j.refresh_token ?? opts.refreshToken,
      expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000,
    };
  }
  ```

- [ ] **Step 3: Run + commit**

  ```bash
  pnpm test
  git add packages/hub/src/agents/claude/refresh-oauth.ts packages/hub/src/agents/claude/refresh-oauth.test.ts
  git commit -m "hub: Claude OAuth refresh (matches refresh path of mode-b-prime.mjs)"
  ```

### Task 43: Mode B′ (direct API call)

**Files:**
- Create: `packages/hub/src/summarizer/prompt-assembler.ts`, `packages/hub/src/summarizer/prompt-assembler.test.ts`
- Create: `packages/hub/src/summarizer/mode-b-prime.ts`, `packages/hub/src/summarizer/mode-b-prime.test.ts`

- [ ] **Step 1: Test the prompt assembler**

  ```typescript
  // packages/hub/src/summarizer/prompt-assembler.test.ts
  import { describe, it, expect } from 'vitest';
  import { assemblePrompt } from './prompt-assembler.js';

  describe('assemblePrompt', () => {
    it('always retains user prompt and final assistant output even when budget tight', () => {
      const input = assemblePrompt({
        previousSummary: { oneLine: 'x', bullets: [] },
        events: [
          { kind: 'user-prompt', text: 'fix the test' },
          ...Array.from({ length: 30 }, () => ({ kind: 'tool-call' as const, text: 'long ' + 'x'.repeat(800) })),
          { kind: 'agent-output', text: 'all done' },
        ],
        maxChars: 2000,
      });
      expect(input).toContain('fix the test');
      expect(input).toContain('all done');
    });
    it('drops middle items first when over budget', () => {
      const input = assemblePrompt({
        previousSummary: null,
        events: [
          { kind: 'user-prompt', text: 'A' },
          { kind: 'tool-call', text: 'B' + 'x'.repeat(2000) },
          { kind: 'tool-result', text: 'C' + 'x'.repeat(2000) },
          { kind: 'agent-output', text: 'Z' },
        ],
        maxChars: 200,
      });
      expect(input).toContain('A');
      expect(input).toContain('Z');
    });
  });
  ```

- [ ] **Step 2: Implement the prompt assembler**

  ```typescript
  // packages/hub/src/summarizer/prompt-assembler.ts
  export interface AssembleInput {
    previousSummary: { oneLine: string; bullets: string[] } | null;
    events: { kind: 'user-prompt' | 'tool-call' | 'tool-result' | 'agent-output' | 'error'; text: string }[];
    maxChars: number;
  }

  const PER_ITEM_MAX = 500;

  export function assemblePrompt(opts: AssembleInput): string {
    const lines: string[] = [];
    if (opts.previousSummary) {
      lines.push('PREVIOUS SUMMARY:');
      lines.push(opts.previousSummary.oneLine);
      for (const b of opts.previousSummary.bullets) lines.push('- ' + b);
      lines.push('');
    }
    lines.push('NEW EVENTS:');
    const trunc = (s: string): string => (s.length > PER_ITEM_MAX ? s.slice(0, PER_ITEM_MAX) + '...' : s);
    const items = opts.events.map((e) => `[${e.kind}] ${trunc(e.text)}`);
    // Always retain the first user-prompt and the last agent-output if present.
    const firstUserIdx = items.findIndex((s) => s.startsWith('[user-prompt]'));
    const lastOutIdx = (() => {
      for (let i = items.length - 1; i >= 0; i--) if (items[i]!.startsWith('[agent-output]')) return i;
      return -1;
    })();
    let head = items.slice();
    while (head.join('\n').length + lines.join('\n').length > opts.maxChars && head.length > 2) {
      // Drop the middle index that isn't the protected first/last.
      const mid = Math.floor(head.length / 2);
      const protected_ = new Set([firstUserIdx, lastOutIdx].filter((x) => x >= 0));
      let candidate = mid;
      while (protected_.has(candidate) && candidate < head.length - 1) candidate++;
      head.splice(candidate, 1);
    }
    return [...lines, ...head].join('\n');
  }
  ```

- [ ] **Step 3: Test Mode B′ (msw mocked)**

  ```typescript
  // packages/hub/src/summarizer/mode-b-prime.test.ts
  import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
  import { setupServer } from 'msw/node';
  import { http, HttpResponse } from 'msw';
  import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';
  import { runModeBPrime } from './mode-b-prime.js';

  let dir: string;
  let lastReq: any = null;
  const server = setupServer(
    http.post('https://api.anthropic.com/v1/messages', async ({ request }) => {
      lastReq = { headers: Object.fromEntries(request.headers), body: await request.json() };
      return HttpResponse.json({
        id: 'msg_x', model: 'claude-haiku-4-5',
        content: [{ type: 'text', text: '{"oneLine":"hi","bullets":[],"needsDecision":false,"suggestedNext":null}' }],
        usage: { input_tokens: 60, output_tokens: 20 },
      });
    }),
  );
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mbp-')); lastReq = null; });
  afterEach(() => { server.resetHandlers(); rmSync(dir, { recursive: true, force: true }); });
  afterAll(() => server.close());

  function writeCreds(): string {
    const p = join(dir, 'cred.json');
    writeFileSync(p, JSON.stringify({
      claudeAiOauth: {
        accessToken: 'TOK', refreshToken: 'R', expiresAt: Date.now() + 3600_000,
        scopes: [], subscriptionType: 'max', rateLimitTier: 'x',
      },
    }));
    return p;
  }

  describe('runModeBPrime', () => {
    it('sends Bearer + anthropic-beta + cli user-agent + Claude Code system prefix', async () => {
      const r = await runModeBPrime({
        credentialsPath: writeCreds(),
        prompt: 'summarize this',
        instructions: 'reply in JSON',
        model: 'claude-haiku-4-5',
        maxOutputTokens: 250,
      });
      expect(r.text).toContain('hi');
      expect(lastReq.headers.authorization).toBe('Bearer TOK');
      expect(lastReq.headers['anthropic-beta']).toBe('oauth-2025-04-20');
      expect(lastReq.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
      expect(lastReq.headers['x-app']).toBe('cli');
      expect(lastReq.headers['user-agent']).toMatch(/^claude-cli\/.* \(external, cli\)$/);
      expect(lastReq.body.system[0].text).toContain("You are Claude Code, Anthropic's official CLI for Claude.");
      expect(lastReq.body.metadata.user_id).toMatch(/^user_[0-9a-f]+_account__session_[0-9a-f]+$/);
    });
    it('refreshes when expiresAt is near', async () => {
      const p = join(dir, 'cred.json');
      writeFileSync(p, JSON.stringify({
        claudeAiOauth: { accessToken: 'OLD', refreshToken: 'R', expiresAt: Date.now() + 5_000, scopes: [], subscriptionType: 'max', rateLimitTier: 'x' },
      }));
      let refreshed = false;
      server.use(
        http.post('https://console.anthropic.com/v1/oauth/token', () => {
          refreshed = true;
          return HttpResponse.json({ access_token: 'NEW', expires_in: 3600 });
        }),
      );
      await runModeBPrime({ credentialsPath: p, prompt: 'p', instructions: 'i', model: 'claude-haiku-4-5', maxOutputTokens: 100 });
      expect(refreshed).toBe(true);
      expect(lastReq.headers.authorization).toBe('Bearer NEW');
    });
    it('throws on 401', async () => {
      server.use(http.post('https://api.anthropic.com/v1/messages', () => HttpResponse.text('nope', { status: 401 })));
      await expect(runModeBPrime({
        credentialsPath: writeCreds(), prompt: 'p', instructions: 'i', model: 'claude-haiku-4-5', maxOutputTokens: 100,
      })).rejects.toMatchObject({ kind: 'auth' });
    });
  });
  ```

- [ ] **Step 4: Implement Mode B′**

  ```typescript
  // packages/hub/src/summarizer/mode-b-prime.ts
  import { randomBytes } from 'node:crypto';
  import { readClaudeCredentials, writeClaudeCredentialsAtomic } from '../agents/claude/credentials.js';
  import { refreshClaudeOAuth } from '../agents/claude/refresh-oauth.js';

  const MESSAGES_URL = 'https://api.anthropic.com/v1/messages?beta=true';
  const ANTHROPIC_VERSION = '2023-06-01';
  const ANTHROPIC_BETA = 'oauth-2025-04-20';
  const CLAUDE_CLI_VERSION = '2.1.126';
  const USER_AGENT = `claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`;
  const SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";
  const REFRESH_BUFFER_MS = 60_000;

  export interface ModeBPrimeInput {
    credentialsPath: string;
    prompt: string;
    instructions: string;
    model: string;
    maxOutputTokens: number;
    timeoutMs?: number;
  }

  export interface ModeBPrimeResult {
    text: string;
    inputTokens: number;
    outputTokens: number;
    model: string;
  }

  export class ModeBPrimeError extends Error {
    constructor(public kind: 'auth' | 'rate-limit' | 'network' | 'parse', message: string, public status?: number) { super(message); }
  }

  function randHex(bytes: number): string {
    return randomBytes(bytes).toString('hex');
  }

  export async function runModeBPrime(input: ModeBPrimeInput): Promise<ModeBPrimeResult> {
    let creds = readClaudeCredentials(input.credentialsPath);
    if (!creds) throw new ModeBPrimeError('auth', 'no credentials at ' + input.credentialsPath);
    if (creds.expiresAt - Date.now() < REFRESH_BUFFER_MS) {
      const refreshed = await refreshClaudeOAuth({ refreshToken: creds.refreshToken });
      creds = { ...creds, ...refreshed };
      writeClaudeCredentialsAtomic(input.credentialsPath, creds);
    }

    const body = {
      model: input.model,
      max_tokens: input.maxOutputTokens,
      system: [
        { type: 'text', text: SYSTEM_PREFIX, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: input.instructions },
      ],
      messages: [{ role: 'user', content: input.prompt }],
      metadata: { user_id: `user_${randHex(8)}_account__session_${randHex(16)}` },
    };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), input.timeoutMs ?? 15000);
    let r: Response;
    try {
      r = await fetch(MESSAGES_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${creds.accessToken}`,
          'anthropic-version': ANTHROPIC_VERSION,
          'anthropic-beta': ANTHROPIC_BETA,
          'anthropic-dangerous-direct-browser-access': 'true',
          'x-app': 'cli',
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Accept-Encoding': 'identity',
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) { throw new ModeBPrimeError('network', String(e)); }
    finally { clearTimeout(timer); }

    if (r.status === 401 || r.status === 403) throw new ModeBPrimeError('auth', `auth failed: ${r.status}`, r.status);
    if (r.status === 429) throw new ModeBPrimeError('rate-limit', 'rate limited', 429);
    if (!r.ok) throw new ModeBPrimeError('network', `http ${r.status}`, r.status);

    let j: any;
    try { j = await r.json(); } catch { throw new ModeBPrimeError('parse', 'invalid JSON'); }
    const text = (j.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    return {
      text,
      inputTokens: j.usage?.input_tokens ?? 0,
      outputTokens: j.usage?.output_tokens ?? 0,
      model: j.model ?? input.model,
    };
  }
  ```

- [ ] **Step 5: Run + commit**

  ```bash
  pnpm test
  git add packages/hub/src/summarizer/
  git commit -m "hub: Mode B' direct Anthropic Messages API call (with refresh)"
  ```

### Task 44: Mode B (subprocess fallback) and heuristic fallback

**Files:**
- Create: `packages/hub/src/summarizer/mode-b.ts`, `packages/hub/src/summarizer/mode-b.test.ts`
- Create: `packages/hub/src/summarizer/heuristic.ts`, `packages/hub/src/summarizer/heuristic.test.ts`

- [ ] **Step 1: Mode B test**

  ```typescript
  // packages/hub/src/summarizer/mode-b.test.ts
  import { describe, it, expect } from 'vitest';
  import { runModeB } from './mode-b.js';

  describe('runModeB', () => {
    it('parses claude -p JSON output', async () => {
      // Use `node -e` as a stand-in for claude that emits the json shape claude -p produces.
      const stub = process.execPath;
      const stubArgs = ['-e', `process.stdout.write(JSON.stringify({result: '{"oneLine":"hi","bullets":[],"needsDecision":false,"suggestedNext":null}', usage:{input_tokens:1,output_tokens:1}}))`];
      const r = await runModeB({
        binary: stub, args: stubArgs, prompt: 'ignored', instructions: 'ignored', model: 'claude-haiku-4-5', timeoutMs: 5000,
      });
      expect(r.text).toContain('hi');
    });
    it('throws on non-zero exit', async () => {
      await expect(runModeB({
        binary: process.execPath, args: ['-e', 'process.exit(1)'],
        prompt: 'p', instructions: 'i', model: 'm', timeoutMs: 1000,
      })).rejects.toThrow();
    });
    it('throws on timeout', async () => {
      await expect(runModeB({
        binary: process.execPath, args: ['-e', 'setTimeout(()=>{},5000)'],
        prompt: 'p', instructions: 'i', model: 'm', timeoutMs: 100,
      })).rejects.toThrow();
    });
  });
  ```

- [ ] **Step 2: Mode B implementation**

  ```typescript
  // packages/hub/src/summarizer/mode-b.ts
  import { spawn } from 'node:child_process';

  export interface ModeBInput {
    /** Defaults to 'claude' on PATH. */
    binary?: string;
    /** Defaults to a sensible argv for our use. Override allows tests. */
    args?: string[];
    prompt: string;
    instructions: string;
    model: string;
    timeoutMs: number;
  }

  export interface ModeBResult {
    text: string;
    inputTokens: number;
    outputTokens: number;
    model: string;
  }

  export async function runModeB(input: ModeBInput): Promise<ModeBResult> {
    const bin = input.binary ?? 'claude';
    const args = input.args ?? [
      '-p', '--model', input.model, '--output-format', 'json',
      '--tools', '', '--no-session-persistence',
      '--exclude-dynamic-system-prompt-sections',
      '--system-prompt', input.instructions,
      input.prompt,
    ];

    return new Promise<ModeBResult>((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; let err = '';
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} reject(new Error('mode-b timeout')); }, input.timeoutMs);
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(`mode-b exit ${code}: ${err.slice(0, 500)}`));
        try {
          const j = JSON.parse(out);
          resolve({
            text: j.result ?? '',
            inputTokens: j.usage?.input_tokens ?? 0,
            outputTokens: j.usage?.output_tokens ?? 0,
            model: j.model ?? input.model,
          });
        } catch (e) { reject(new Error('mode-b parse: ' + String(e))); }
      });
    });
  }
  ```

- [ ] **Step 3: Heuristic test**

  ```typescript
  // packages/hub/src/summarizer/heuristic.test.ts
  import { describe, it, expect } from 'vitest';
  import { heuristicSummary } from './heuristic.js';

  describe('heuristicSummary', () => {
    it('takes the last non-empty line as oneLine', () => {
      const r = heuristicSummary('a\n\033[31mred\033[0m\nfoo\n\n');
      expect(r.oneLine).toBe('foo');
    });
    it('strips ANSI', () => {
      const r = heuristicSummary('\x1b[31mhello\x1b[0m');
      expect(r.oneLine).toBe('hello');
    });
    it('produces empty result on empty input', () => {
      expect(heuristicSummary('').oneLine).toBe('');
    });
  });
  ```

- [ ] **Step 4: Heuristic implementation**

  ```typescript
  // packages/hub/src/summarizer/heuristic.ts
  export interface HeuristicResult {
    oneLine: string;
    bullets: string[];
    needsDecision: false;
    suggestedNext: null;
  }

  function stripAnsi(s: string): string {
    return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
  }

  export function heuristicSummary(rawTail: string): HeuristicResult {
    const lines = stripAnsi(rawTail).split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    const last = lines[lines.length - 1] ?? '';
    const bullets = lines.slice(-5, -1).reverse().slice(0, 4);
    return {
      oneLine: last.slice(0, 100),
      bullets: bullets.map((b) => b.slice(0, 80)),
      needsDecision: false,
      suggestedNext: null,
    };
  }
  ```

- [ ] **Step 5: Run + commit**

  ```bash
  pnpm test
  git add packages/hub/src/summarizer/
  git commit -m "hub: Mode B subprocess fallback + heuristic last-resort"
  ```

### Task 45: Summarizer orchestrator

**Files:**
- Create: `packages/hub/src/summarizer/index.ts`, `packages/hub/src/summarizer/index.test.ts`

The orchestrator is what the rest of the hub calls. It chooses Mode B′ → Mode B → heuristic in that order, applies the cooldown ("disable B′ for the session after a 401"), and parses the model output as a `Summary`.

- [ ] **Step 1: Test**

  ```typescript
  // packages/hub/src/summarizer/index.test.ts
  import { describe, it, expect, beforeEach } from 'vitest';
  import { Summarizer } from './index.js';

  function fakeBPrime({ failKind = null as 'auth'|'rate-limit'|null, text = '{"oneLine":"x","bullets":[],"needsDecision":false,"suggestedNext":null}' }) {
    return async () => {
      if (failKind) { const e: any = new Error(failKind); e.kind = failKind; throw e; }
      return { text, inputTokens: 60, outputTokens: 5, model: 'claude-haiku-4-5' };
    };
  }
  function fakeB(text = '{"oneLine":"y","bullets":[],"needsDecision":false,"suggestedNext":null}') {
    return async () => ({ text, inputTokens: 22000, outputTokens: 5, model: 'claude-haiku-4-5' });
  }

  describe('Summarizer', () => {
    it('uses Mode B prime first, returns parsed Summary', async () => {
      const s = new Summarizer({ modeBPrime: fakeBPrime({}) , modeB: fakeB(), heuristicTail: () => '' });
      const r = await s.summarize({ sessionId: 's1', previousSummary: null, events: [] });
      expect(r.oneLine).toBe('x');
      expect(r.summaryId).toMatch(/^sum-/);
    });
    it('falls through to Mode B on 401 and disables Bprime for the session', async () => {
      let calls = 0;
      const s = new Summarizer({
        modeBPrime: async () => { calls++; const e: any = new Error('a'); e.kind = 'auth'; throw e; },
        modeB: fakeB(),
        heuristicTail: () => '',
      });
      const r1 = await s.summarize({ sessionId: 's1', previousSummary: null, events: [] });
      expect(r1.oneLine).toBe('y');
      const r2 = await s.summarize({ sessionId: 's1', previousSummary: null, events: [] });
      expect(r2.oneLine).toBe('y');
      expect(calls).toBe(1);  // didn't retry B' for s1
    });
    it('falls through to heuristic when both fail', async () => {
      const s = new Summarizer({
        modeBPrime: async () => { throw new Error('net'); },
        modeB:      async () => { throw new Error('boom'); },
        heuristicTail: (sid) => sid === 's1' ? 'last\nline' : '',
      });
      const r = await s.summarize({ sessionId: 's1', previousSummary: null, events: [] });
      expect(r.oneLine).toBe('line');
    });
  });
  ```

- [ ] **Step 2: Implement**

  ```typescript
  // packages/hub/src/summarizer/index.ts
  import { randomUUID } from 'node:crypto';
  import { assemblePrompt } from './prompt-assembler.js';
  import { heuristicSummary } from './heuristic.js';
  import type { Summary } from '@sesshin/shared';

  export interface SummarizeInput {
    sessionId: string;
    previousSummary: { oneLine: string; bullets: string[] } | null;
    events: { kind: 'user-prompt' | 'tool-call' | 'tool-result' | 'agent-output' | 'error'; text: string }[];
  }

  export interface ModeFn {
    (req: { prompt: string; instructions: string; model: string; maxOutputTokens: number }): Promise<{ text: string; inputTokens: number; outputTokens: number; model: string }>;
  }

  export interface SummarizerDeps {
    modeBPrime: ModeFn;
    modeB:      ModeFn;
    heuristicTail: (sessionId: string) => string;
    instructions?: string;
    model?: string;
    maxOutputTokens?: number;
  }

  const SYSTEM_INSTRUCTIONS = `You are a terse summarizer for an ambient awareness system.
Output ONLY a JSON object with the schema:
{"oneLine":"...","bullets":["..."],"needsDecision":bool,"suggestedNext":string|null}
oneLine ≤ 100 chars; bullets ≤ 5 items × 80 chars. No prose.`;

  export class Summarizer {
    private bPrimeDisabled = new Set<string>();
    constructor(private deps: SummarizerDeps) {}

    async summarize(input: SummarizeInput): Promise<Summary> {
      const prompt = assemblePrompt({ previousSummary: input.previousSummary, events: input.events, maxChars: 8000 });
      const req = {
        prompt,
        instructions: this.deps.instructions ?? SYSTEM_INSTRUCTIONS,
        model: this.deps.model ?? 'claude-haiku-4-5',
        maxOutputTokens: this.deps.maxOutputTokens ?? 250,
      };

      // Mode B prime (unless disabled for this session)
      if (!this.bPrimeDisabled.has(input.sessionId)) {
        try {
          const r = await this.deps.modeBPrime(req);
          return parseSummary(r.text, r.model);
        } catch (e: any) {
          if (e?.kind === 'auth') this.bPrimeDisabled.add(input.sessionId);
          // fall through to Mode B
        }
      }

      // Mode B subprocess
      try {
        const r = await this.deps.modeB(req);
        return parseSummary(r.text, r.model);
      } catch { /* fall through */ }

      // Heuristic last resort
      const tail = this.deps.heuristicTail(input.sessionId);
      const h = heuristicSummary(tail);
      return {
        summaryId: 'sum-' + randomUUID().slice(0, 8),
        oneLine: h.oneLine, bullets: h.bullets,
        needsDecision: false, suggestedNext: null,
        since: input.previousSummary ? 'prev' : null,
        generatedAt: Date.now(), generatorModel: 'heuristic',
      };
    }
  }

  function parseSummary(text: string, model: string): Summary {
    let parsed: any;
    try { parsed = JSON.parse(text); } catch {
      // The model emitted prose around JSON; attempt to extract the JSON object.
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start >= 0 && end > start) parsed = JSON.parse(text.slice(start, end + 1));
      else parsed = { oneLine: text.slice(0, 100), bullets: [], needsDecision: false, suggestedNext: null };
    }
    return {
      summaryId: 'sum-' + randomUUID().slice(0, 8),
      oneLine: String(parsed.oneLine ?? '').slice(0, 100),
      bullets: Array.isArray(parsed.bullets) ? parsed.bullets.slice(0, 5).map((b: unknown) => String(b).slice(0, 80)) : [],
      needsDecision: Boolean(parsed.needsDecision),
      suggestedNext: parsed.suggestedNext ?? null,
      since: null,
      generatedAt: Date.now(),
      generatorModel: model,
    };
  }
  ```

- [ ] **Step 3: Run + commit**

  ```bash
  pnpm test
  git add packages/hub/src/summarizer/
  git commit -m "hub: Summarizer orchestrator (B' → B → heuristic) with per-session B' disable"
  ```

### Task 46: Summarizer trigger on Stop + broadcast

**Files:**
- Modify: `packages/hub/src/wire.ts`
- Create: `packages/hub/src/summarizer-trigger.ts`, `packages/hub/src/summarizer-trigger.test.ts`

- [ ] **Step 1: Test**

  ```typescript
  // packages/hub/src/summarizer-trigger.test.ts
  import { describe, it, expect } from 'vitest';
  import { wireSummarizerTrigger } from './summarizer-trigger.js';
  import { EventBus } from './event-bus.js';
  import { SessionRegistry } from './registry/session-registry.js';
  import { Summarizer } from './summarizer/index.js';

  function fakeSummarizer(label = 'ok') {
    return new Summarizer({
      modeBPrime: async () => ({ text: `{"oneLine":"${label}","bullets":[],"needsDecision":false,"suggestedNext":null}`, inputTokens: 1, outputTokens: 1, model: 'claude-haiku-4-5' }),
      modeB:      async () => { throw new Error('not used'); },
      heuristicTail: () => '',
    });
  }

  describe('summarizer trigger', () => {
    it('fires on agent-output for a known session and broadcasts session.summary', async () => {
      const reg = new SessionRegistry(); reg.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
      const bus = new EventBus();
      const broadcasts: any[] = [];
      wireSummarizerTrigger({ bus, registry: reg, summarizer: fakeSummarizer('hi'), broadcast: (m) => broadcasts.push(m) });
      bus.emit({ eventId: 'e1', sessionId: 's1', kind: 'user-prompt', payload: { prompt: 'do' }, source: 'observer:hook-ingest', ts: 1 });
      bus.emit({ eventId: 'e2', sessionId: 's1', kind: 'agent-output', payload: { stopReason: 'end_turn' }, source: 'observer:hook-ingest', ts: 2 });
      await new Promise((r) => setTimeout(r, 20));
      const summary = broadcasts.find((b) => b.type === 'session.summary');
      expect(summary).toBeTruthy();
      expect(summary.oneLine).toBe('hi');
      expect(reg.get('s1')!.lastSummaryId).toBeTruthy();
    });
  });
  ```

- [ ] **Step 2: Implement**

  ```typescript
  // packages/hub/src/summarizer-trigger.ts
  import type { EventBus, NormalizedEvent } from './event-bus.js';
  import type { SessionRegistry } from './registry/session-registry.js';
  import type { Summarizer } from './summarizer/index.js';

  export interface TriggerDeps {
    bus: EventBus;
    registry: SessionRegistry;
    summarizer: Summarizer;
    broadcast: (msg: object) => void;
  }

  export function wireSummarizerTrigger(deps: TriggerDeps): void {
    const buffers = new Map<string, NormalizedEvent[]>();
    deps.bus.on(async (e) => {
      const arr = buffers.get(e.sessionId) ?? [];
      arr.push(e); buffers.set(e.sessionId, arr);
      if (e.kind !== 'agent-output' && e.kind !== 'error') return;
      const session = deps.registry.get(e.sessionId);
      if (!session) return;
      const events = arr.splice(0).map(toSummaryEvent).filter((x): x is { kind: any; text: string } => !!x);
      const summary = await deps.summarizer.summarize({
        sessionId: e.sessionId,
        previousSummary: session.lastSummaryId ? { oneLine: '(prev)', bullets: [] } : null,
        events,
      });
      deps.registry.setLastSummary(e.sessionId, summary.summaryId);
      if (summary.needsDecision) deps.registry.updateState(e.sessionId, 'awaiting-input');
      deps.broadcast({ type: 'session.summary', sessionId: e.sessionId, ...summary });
    });
  }

  function toSummaryEvent(e: NormalizedEvent): { kind: 'user-prompt'|'tool-call'|'tool-result'|'agent-output'|'error'; text: string } | null {
    switch (e.kind) {
      case 'user-prompt':   return { kind: 'user-prompt',  text: String(e.payload['prompt'] ?? '') };
      case 'tool-call':     return { kind: 'tool-call',    text: `${e.payload['tool']}(${JSON.stringify(e.payload['input'] ?? {})})` };
      case 'tool-result':   return { kind: 'tool-result',  text: String(e.payload['result'] ?? '') };
      case 'agent-output':  return { kind: 'agent-output', text: String(e.payload['stopReason'] ?? '') };
      case 'error':         return { kind: 'error',        text: String(e.payload['error'] ?? '') };
      default: return null;
    }
  }
  ```

- [ ] **Step 3: Wire it in `wire.ts`**

  Inside `startHub`, after `wireStateMachine` and before `createWsServer`:

  ```typescript
  import { Summarizer } from './summarizer/index.js';
  import { runModeBPrime } from './summarizer/mode-b-prime.js';
  import { runModeB } from './summarizer/mode-b.js';
  import { wireSummarizerTrigger } from './summarizer-trigger.js';
  import { join } from 'node:path';
  import { homedir } from 'node:os';

  const summarizer = new Summarizer({
    modeBPrime: (req) => runModeBPrime({
      credentialsPath: join(homedir(), '.claude', '.credentials.json'),
      prompt: req.prompt, instructions: req.instructions, model: req.model, maxOutputTokens: req.maxOutputTokens,
    }),
    modeB: (req) => runModeB({
      prompt: req.prompt, instructions: req.instructions, model: req.model, timeoutMs: 30_000,
    }),
    heuristicTail: (sid) => tap.snapshot(sid).toString('utf-8'),
  });
  wireSummarizerTrigger({ bus: dedupedBus, registry, summarizer, broadcast: (m) => ws.broadcast(m) });
  ```

- [ ] **Step 4: Run + commit**

  ```bash
  pnpm test
  git add packages/hub/src/
  git commit -m "hub: summarizer trigger (Stop → Mode B' → broadcast session.summary)"
  ```

### Task 47: M6 milestone checkpoint

- [ ] **Step 1: All tests pass**

  ```bash
  pnpm test
  ```

- [ ] **Step 2: Build hub and run a more comprehensive smoke test using msw**

  Defer to Layer 2 integration tests; manual smoke now would require a real claude session.

- [ ] **Step 3: Tag**

  ```bash
  git tag M6
  ```

The hub is now feature-complete: registry + observers + state machine + WS + summarizer + input arbiter. M7 starts the CLI to feed it real events.

---

## Milestone M7: `@sesshin/cli` — minimal `sesshin claude`

By the end of M7, `sesshin claude` runs claude wrapped in a PTY, registers with the hub, and forwards hook events. No input injection yet (M8).

### Task 48: CLI package skeleton

**Files:**
- Create: `packages/cli/{package.json,tsconfig.json,tsup.config.ts,vitest.config.ts,bin/sesshin,src/main.ts}`

- [ ] **Step 1: `packages/cli/package.json`**

  ```json
  {
    "name": "@sesshin/cli",
    "version": "0.0.0",
    "type": "module",
    "private": true,
    "bin": { "sesshin": "bin/sesshin" },
    "scripts": {
      "build": "tsup",
      "dev": "tsup --watch",
      "test": "vitest run",
      "test:watch": "vitest"
    },
    "dependencies": {
      "@sesshin/shared": "workspace:*",
      "@sesshin/hub": "workspace:*",
      "@sesshin/hook-handler": "workspace:*",
      "node-pty": "^1.0.0",
      "ws": "^8.18.0"
    },
    "devDependencies": { "@types/node": "^22.0.0", "@types/ws": "^8.5.0", "tsup": "^8.3.0", "vitest": "^2.1.0" }
  }
  ```

- [ ] **Step 2: tsconfig + tsup + vitest configs (mirror hub).**

- [ ] **Step 3: `packages/cli/bin/sesshin`**

  ```sh
  #!/usr/bin/env node
  import('../dist/main.js');
  ```
  Then `chmod +x`.

- [ ] **Step 4: `packages/cli/src/main.ts` (subcommand dispatch)**

  ```typescript
  import { runClaude } from './claude.js';

  async function main(): Promise<void> {
    const sub = process.argv[2];
    if (sub === 'claude') return await runClaude(process.argv.slice(3));
    process.stderr.write(`Usage: sesshin claude [-- claude-args...]\n`);
    process.exit(2);
  }
  main().catch((e) => { process.stderr.write(`fatal: ${e?.stack ?? e}\n`); process.exit(1); });
  ```

- [ ] **Step 5: Stub `claude.ts` + commit**

  ```typescript
  // packages/cli/src/claude.ts
  export async function runClaude(_args: string[]): Promise<void> {
    process.stderr.write('sesshin claude: implementation lands in T49+\n');
    process.exit(0);
  }
  ```

  ```bash
  pnpm install && cd packages/cli && pnpm build
  git add packages/cli/ pnpm-lock.yaml
  git commit -m "cli: package skeleton + main subcommand dispatch"
  ```

### Task 49: Hub auto-spawn + stale detection

**Files:**
- Create: `packages/cli/src/hub-spawn.ts`, `packages/cli/src/hub-spawn.test.ts`

- [ ] **Step 1: Test**

  ```typescript
  // packages/cli/src/hub-spawn.test.ts
  import { describe, it, expect } from 'vitest';
  import { ensureHubRunning } from './hub-spawn.js';
  import { createServer } from 'node:http';

  describe('ensureHubRunning', () => {
    it('returns immediately when /api/health responds 200', async () => {
      const port = 19663;
      const s = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
      await new Promise<void>((r) => s.listen(port, '127.0.0.1', () => r()));
      try {
        const res = await ensureHubRunning({ hubBin: 'echo-not-used', port, healthTimeoutMs: 1000 });
        expect(res.spawned).toBe(false);
      } finally { s.close(); }
    });
    it('spawns when /api/health unreachable; resolves once new instance answers', async () => {
      // Use a tiny stub binary that listens on a port and returns 200.
      const port = 19664;
      const stub = `process.argv[2] && require('http').createServer((req,res)=>{res.writeHead(200);res.end('{"ok":true}')}).listen(${port},'127.0.0.1');`;
      const stubBin = process.execPath;
      const stubArgs = ['-e', stub, 'go'];
      const res = await ensureHubRunning({ hubBin: stubBin, hubArgs: stubArgs, port, healthTimeoutMs: 5000 });
      expect(res.spawned).toBe(true);
      // give the stub a moment to release the port
      await new Promise((r) => setTimeout(r, 50));
    }, 10000);
  });
  ```

- [ ] **Step 2: Implement**

  ```typescript
  // packages/cli/src/hub-spawn.ts
  import { spawn } from 'node:child_process';

  export interface EnsureHubInput {
    hubBin: string;
    hubArgs?: string[];
    port: number;
    healthTimeoutMs: number;
  }

  export async function ensureHubRunning(opts: EnsureHubInput): Promise<{ spawned: boolean }> {
    if (await healthOk(opts.port, 500)) return { spawned: false };
    const child = spawn(opts.hubBin, opts.hubArgs ?? [], { detached: true, stdio: 'ignore' });
    child.unref();
    const ok = await waitForHealth(opts.port, opts.healthTimeoutMs);
    if (!ok) throw new Error(`hub failed to come up within ${opts.healthTimeoutMs}ms`);
    return { spawned: true };
  }

  async function healthOk(port: number, timeoutMs: number): Promise<boolean> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ctrl.signal });
      return r.ok;
    } catch { return false; }
    finally { clearTimeout(t); }
  }

  async function waitForHealth(port: number, totalMs: number): Promise<boolean> {
    const deadline = Date.now() + totalMs;
    while (Date.now() < deadline) {
      if (await healthOk(port, 200)) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }
  ```

- [ ] **Step 3: Run + commit**

  ```bash
  pnpm test
  git add packages/cli/src/hub-spawn.ts packages/cli/src/hub-spawn.test.ts
  git commit -m "cli: hub auto-spawn + health probe"
  ```

### Task 50: Settings tempfile generator (and merge fallback)

**Files:**
- Create: `packages/cli/src/settings-tempfile.ts`, `packages/cli/src/settings-tempfile.test.ts`
- Create: `packages/cli/src/settings-merge.ts`, `packages/cli/src/settings-merge.test.ts`

- [ ] **Step 1: Test simple generator**

  ```typescript
  // packages/cli/src/settings-tempfile.test.ts
  import { describe, it, expect } from 'vitest';
  import { generateHooksOnlySettings } from './settings-tempfile.js';

  describe('generateHooksOnlySettings', () => {
    it('emits only a hooks key', () => {
      const j = JSON.parse(generateHooksOnlySettings({ hookHandlerPath: '/p/handler', sessionId: 's1', hubUrl: 'http://h:1', agent: 'claude-code' }));
      expect(Object.keys(j)).toEqual(['hooks']);
    });
    it('covers the seven Claude hook events', () => {
      const j = JSON.parse(generateHooksOnlySettings({ hookHandlerPath: '/p', sessionId: 's', hubUrl: 'h', agent: 'claude-code' }));
      expect(Object.keys(j.hooks).sort()).toEqual([
        'PostToolUse','PreToolUse','SessionEnd','SessionStart','Stop','StopFailure','UserPromptSubmit',
      ]);
    });
    it('passes session env into each hook entry', () => {
      const j = JSON.parse(generateHooksOnlySettings({ hookHandlerPath: '/p', sessionId: 'SID', hubUrl: 'http://x:9', agent: 'claude-code' }));
      expect(j.hooks.Stop[0].hooks[0].env.SESSHIN_SESSION_ID).toBe('SID');
      expect(j.hooks.Stop[0].hooks[0].env.SESSHIN_HUB_URL).toBe('http://x:9');
      expect(j.hooks.Stop[0].hooks[0].command).toContain('/p');
    });
  });
  ```

- [ ] **Step 2: Implement**

  ```typescript
  // packages/cli/src/settings-tempfile.ts
  export interface HooksSettingsInput {
    hookHandlerPath: string;
    sessionId: string;
    hubUrl: string;
    agent: 'claude-code';
  }

  const EVENTS = ['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','Stop','StopFailure','SessionEnd'] as const;

  export function generateHooksOnlySettings(o: HooksSettingsInput): string {
    const env = {
      SESSHIN_HUB_URL:    o.hubUrl,
      SESSHIN_SESSION_ID: o.sessionId,
      SESSHIN_AGENT:      o.agent,
    };
    const hooks: Record<string, unknown> = {};
    for (const evt of EVENTS) {
      hooks[evt] = [{
        matcher: '*',
        hooks: [{
          type: 'command',
          command: `${o.hookHandlerPath} ${evt}`,
          env,
        }],
      }];
    }
    return JSON.stringify({ hooks }, null, 2);
  }
  ```

- [ ] **Step 3: Test merge fallback**

  ```typescript
  // packages/cli/src/settings-merge.test.ts
  import { describe, it, expect } from 'vitest';
  import { mergeUserHooksWithOurs } from './settings-merge.js';

  describe('mergeUserHooksWithOurs', () => {
    it('prepends user Stop hooks before ours, preserves matchers', () => {
      const ours = { hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'OURS' }] }] } };
      const userSettings = { hooks: { Stop: [{ matcher: 'tools.*', hooks: [{ type: 'command', command: 'USER' }] }] } };
      const merged = mergeUserHooksWithOurs(ours, userSettings);
      expect(merged.hooks.Stop).toHaveLength(2);
      expect(merged.hooks.Stop[0].hooks[0].command).toBe('USER');
      expect(merged.hooks.Stop[1].hooks[0].command).toBe('OURS');
    });
    it('passes through user keys other than hooks unchanged', () => {
      const ours = { hooks: {} };
      const userSettings = { hooks: {}, model: 'something', mcpServers: { x: 1 } };
      const merged = mergeUserHooksWithOurs(ours, userSettings) as any;
      // Our temp file shouldn't carry user model/mcp/etc — those load from layers Claude reads itself.
      expect(merged).toEqual({ hooks: {} });
    });
  });
  ```

- [ ] **Step 4: Implement merge**

  ```typescript
  // packages/cli/src/settings-merge.ts
  export interface HooksMap { hooks: Record<string, any[]> }

  export function mergeUserHooksWithOurs(ours: HooksMap, userSettings: any): HooksMap {
    if (!userSettings || typeof userSettings !== 'object') return ours;
    const userHooks = userSettings.hooks ?? {};
    const out: Record<string, any[]> = { ...(ours.hooks ?? {}) };
    for (const [evt, arr] of Object.entries(userHooks)) {
      if (!Array.isArray(arr)) continue;
      out[evt] = [...arr, ...(out[evt] ?? [])];
    }
    return { hooks: out };
  }
  ```

- [ ] **Step 5: Run + commit**

  ```bash
  pnpm test
  git add packages/cli/src/settings-tempfile.ts packages/cli/src/settings-tempfile.test.ts packages/cli/src/settings-merge.ts packages/cli/src/settings-merge.test.ts
  git commit -m "cli: hooks-only settings tempfile generator + merge fallback"
  ```

### Task 51: PTY wrap with raw passthrough

**Files:**
- Create: `packages/cli/src/pty-wrap.ts`, `packages/cli/src/pty-wrap.test.ts`

- [ ] **Step 1: Test (run a simple command through the wrapper)**

  ```typescript
  // packages/cli/src/pty-wrap.test.ts
  import { describe, it, expect } from 'vitest';
  import { wrapPty } from './pty-wrap.js';

  describe('wrapPty', () => {
    it('captures stdout from a child process', async () => {
      const out: string[] = [];
      const wrapper = wrapPty({
        command: '/bin/sh',
        args: ['-c', 'echo hello-pty; sleep 0.05'],
        cwd: process.cwd(),
        env: process.env as Record<string, string>,
        cols: 80, rows: 24,
        passthrough: false,  // no real tty in vitest
      });
      wrapper.onData((d) => out.push(d));
      const exit = await new Promise<number>((r) => wrapper.onExit((c) => r(c)));
      expect(exit).toBe(0);
      expect(out.join('')).toContain('hello-pty');
    });
    it('forwards write() to the child stdin', async () => {
      const out: string[] = [];
      const wrapper = wrapPty({
        command: '/bin/sh',
        args: ['-c', "read line; echo got:$line"],
        cwd: process.cwd(),
        env: process.env as Record<string, string>,
        cols: 80, rows: 24,
        passthrough: false,
      });
      wrapper.onData((d) => out.push(d));
      wrapper.write('hi\n');
      const exit = await new Promise<number>((r) => wrapper.onExit((c) => r(c)));
      expect(exit).toBe(0);
      expect(out.join('')).toContain('got:hi');
    });
  });
  ```

- [ ] **Step 2: Implement**

  ```typescript
  // packages/cli/src/pty-wrap.ts
  import pty, { type IPty } from 'node-pty';

  export interface PtyWrapInput {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    cols: number;
    rows: number;
    /** When true, install raw-mode passthrough on the parent's stdin/stdout. */
    passthrough: boolean;
  }

  export interface PtyWrap {
    write(data: string): void;
    resize(cols: number, rows: number): void;
    onData(fn: (d: string) => void): void;
    onExit(fn: (code: number) => void): void;
    kill(signal?: string): void;
    pid: number;
  }

  export function wrapPty(opts: PtyWrapInput): PtyWrap {
    const proc: IPty = pty.spawn(opts.command, opts.args, {
      name: 'xterm-256color', cwd: opts.cwd, env: opts.env, cols: opts.cols, rows: opts.rows,
    });

    if (opts.passthrough) installPassthrough(proc);

    const dataListeners = new Set<(d: string) => void>();
    proc.onData((d) => { for (const fn of dataListeners) fn(d); });

    return {
      write: (d) => proc.write(d),
      resize: (cols, rows) => proc.resize(cols, rows),
      onData: (fn) => { dataListeners.add(fn); },
      onExit: (fn) => proc.onExit(({ exitCode }) => fn(exitCode)),
      kill: (sig) => proc.kill(sig),
      get pid() { return proc.pid; },
    };
  }

  function installPassthrough(proc: IPty): void {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (d) => proc.write(typeof d === 'string' ? d : d.toString('utf-8')));
    proc.onData((d) => process.stdout.write(d));
    const onResize = (): void => proc.resize(process.stdout.columns ?? 80, process.stdout.rows ?? 24);
    process.stdout.on('resize', onResize);
    proc.onExit(() => {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.off('resize', onResize);
    });
  }
  ```

- [ ] **Step 3: Run + commit**

  ```bash
  pnpm test
  git add packages/cli/src/pty-wrap.ts packages/cli/src/pty-wrap.test.ts
  git commit -m "cli: PTY wrap with raw-mode passthrough + onData/onExit"
  ```

### Task 52: Heartbeat sender + cleanup helpers

**Files:**
- Create: `packages/cli/src/heartbeat.ts`, `packages/cli/src/cleanup.ts`, `packages/cli/src/orphan-cleanup.ts`

- [ ] **Step 1: heartbeat.ts (no test — trivial; covered in T54 e2e)**

  ```typescript
  // packages/cli/src/heartbeat.ts
  export function startHeartbeat(opts: { hubUrl: string; sessionId: string; intervalMs?: number }): () => void {
    const intervalMs = opts.intervalMs ?? 10_000;
    const tick = (): void => {
      void fetch(`${opts.hubUrl}/api/sessions/${opts.sessionId}/heartbeat`, { method: 'POST' }).catch(() => {});
    };
    tick();
    const handle = setInterval(tick, intervalMs);
    return () => clearInterval(handle);
  }
  ```

- [ ] **Step 2: cleanup.ts**

  ```typescript
  // packages/cli/src/cleanup.ts
  import { existsSync, unlinkSync } from 'node:fs';

  export interface CleanupOpts {
    tempSettingsPath: string;
    onShutdown: () => Promise<void> | void;
  }

  export function installCleanup(opts: CleanupOpts): void {
    const reap = (): void => { try { if (existsSync(opts.tempSettingsPath)) unlinkSync(opts.tempSettingsPath); } catch {} };
    let ran = false;
    const handler = async (sig: string): Promise<void> => {
      if (ran) return; ran = true;
      try { await opts.onShutdown(); } catch {}
      reap();
      // Re-raise the signal default action via process.exit
      const code = sig === 'EXIT' ? 0 : 130;
      process.exit(code);
    };
    process.on('SIGINT',  () => handler('SIGINT'));
    process.on('SIGTERM', () => handler('SIGTERM'));
    process.on('exit',    () => reap());
    process.on('uncaughtException', (e) => { process.stderr.write(`uncaught: ${e?.stack ?? e}\n`); reap(); process.exit(1); });
  }
  ```

- [ ] **Step 3: orphan-cleanup.ts**

  ```typescript
  // packages/cli/src/orphan-cleanup.ts
  import { readdirSync, statSync, unlinkSync } from 'node:fs';
  import { join } from 'node:path';
  import { tmpdir } from 'node:os';

  /** Reap /tmp/sesshin-*.json older than the given age. Best-effort, errors swallowed. */
  export function reapOrphanSettingsFiles(maxAgeMs = 60 * 60_000): void {
    const dir = tmpdir();
    try {
      for (const name of readdirSync(dir)) {
        if (!name.startsWith('sesshin-') || !name.endsWith('.json')) continue;
        const path = join(dir, name);
        try {
          const st = statSync(path);
          if (Date.now() - st.mtimeMs > maxAgeMs) unlinkSync(path);
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add packages/cli/src/heartbeat.ts packages/cli/src/cleanup.ts packages/cli/src/orphan-cleanup.ts
  git commit -m "cli: heartbeat + cleanup signal handlers + orphan tempfile reaper"
  ```

### Task 53: Wire it all together — `runClaude`

**Files:**
- Modify: `packages/cli/src/claude.ts`

- [ ] **Step 1: Implement `runClaude` (READ-ONLY: no input injection yet — that's M8)**

  ```typescript
  // packages/cli/src/claude.ts
  import { randomBytes } from 'node:crypto';
  import { writeFileSync, readFileSync, existsSync } from 'node:fs';
  import { tmpdir, homedir } from 'node:os';
  import { join } from 'node:path';
  import { fileURLToPath } from 'node:url';
  import { ensureHubRunning } from './hub-spawn.js';
  import { generateHooksOnlySettings } from './settings-tempfile.js';
  import { mergeUserHooksWithOurs } from './settings-merge.js';
  import { wrapPty } from './pty-wrap.js';
  import { startHeartbeat } from './heartbeat.js';
  import { installCleanup } from './cleanup.js';
  import { reapOrphanSettingsFiles } from './orphan-cleanup.js';
  import { sessionFilePath } from '@sesshin/hub/dist/agents/claude/session-file-path.js';

  const HUB_PORT = Number(process.env['SESSHIN_INTERNAL_PORT'] ?? 9663);
  const HUB_URL  = `http://127.0.0.1:${HUB_PORT}`;

  function resolveBin(envName: string, packageBinName: string): string {
    const override = process.env[envName];
    if (override) return override;
    // Resolve sibling package binary via package import.meta.resolve.
    // Fallback: assume it's on PATH after pnpm install -g.
    try {
      const url = (import.meta as any).resolve(packageBinName);
      return fileURLToPath(url);
    } catch { return packageBinName.split('/').pop()!; }
  }

  export async function runClaude(extraArgs: string[]): Promise<void> {
    reapOrphanSettingsFiles();

    const sessionId = randomBytes(8).toString('hex');
    const hubBin = resolveBin('SESSHIN_HUB_BIN', '@sesshin/hub/bin/sesshin-hub');
    const hookBin = resolveBin('SESSHIN_HOOK_HANDLER_BIN', '@sesshin/hook-handler/bin/sesshin-hook-handler');
    await ensureHubRunning({ hubBin, port: HUB_PORT, healthTimeoutMs: 5000 });

    // Compose hooks-only settings (with optional merge fallback when verification gate 1 = REPLACE)
    const useMerge = process.env['SESSHIN_MERGE_USER_HOOKS'] === '1';
    let settings: object = JSON.parse(generateHooksOnlySettings({ hookHandlerPath: hookBin, sessionId, hubUrl: HUB_URL, agent: 'claude-code' }));
    if (useMerge) {
      const userPath = join(homedir(), '.claude', 'settings.json');
      const userJson = existsSync(userPath) ? JSON.parse(readFileSync(userPath, 'utf-8')) : {};
      settings = mergeUserHooksWithOurs(settings as any, userJson);
    }
    const tempSettingsPath = join(tmpdir(), `sesshin-${sessionId}.json`);
    writeFileSync(tempSettingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });

    // Register
    const cwd = process.cwd();
    const sfp = sessionFilePath({ home: homedir(), cwd, sessionId });
    const reg = await fetch(`${HUB_URL}/api/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: sessionId, name: `claude (${cwd})`, agent: 'claude-code', cwd, pid: process.pid, sessionFilePath: sfp }),
    });
    if (!reg.ok) throw new Error(`hub registration failed: ${reg.status}`);

    const stopHeartbeat = startHeartbeat({ hubUrl: HUB_URL, sessionId });

    installCleanup({
      tempSettingsPath,
      onShutdown: async () => {
        stopHeartbeat();
        try { await fetch(`${HUB_URL}/api/sessions/${sessionId}`, { method: 'DELETE' }); } catch {}
      },
    });

    // Spawn claude under PTY with --settings pointing at our temp file.
    const claudeArgs = ['--settings', tempSettingsPath, ...extraArgs];
    const wrap = wrapPty({
      command: process.env['SESSHIN_CLAUDE_BIN'] ?? 'claude',
      args: claudeArgs,
      cwd,
      env: process.env as Record<string, string>,
      cols: process.stdout.columns ?? 80,
      rows: process.stdout.rows ?? 24,
      passthrough: true,
    });

    // M8 will subscribe to the input bridge for hub→PTY input.
    // M8 will also tee output to /api/sessions/:id/raw.
    wrap.onExit((code) => process.exit(code));
  }
  ```

  Note: the import path `'@sesshin/hub/dist/agents/claude/session-file-path.js'` requires `@sesshin/hub` to expose that subpath. Add to `packages/hub/package.json`:

  ```json
  "exports": {
    ".": "./dist/main.js",
    "./bin/sesshin-hub": "./bin/sesshin-hub",
    "./agents/claude/session-file-path": "./dist/agents/claude/session-file-path.js"
  }
  ```

  And update `tsup.config.ts` entries to include that file.

- [ ] **Step 2: Build all + manual smoke**

  ```bash
  pnpm install
  pnpm build
  cd /tmp
  /home/jiangzhuo/Desktop/kizunaai/sesshin/packages/cli/bin/sesshin claude --help 2>&1 | head -10
  ```

  Expected: claude's own help output appears (PTY-wrapped). hub.log shows the session was registered.

- [ ] **Step 3: Commit**

  ```bash
  cd /home/jiangzhuo/Desktop/kizunaai/sesshin
  git add packages/cli/src/claude.ts packages/hub/package.json packages/hub/tsup.config.ts pnpm-lock.yaml
  git commit -m "cli: runClaude — hub spawn + settings tempfile + PTY wrap + heartbeat (read-only)"
  ```

### Task 54: M7 milestone checkpoint

- [ ] **Step 1: All tests pass**

  ```bash
  pnpm test
  ```

- [ ] **Step 2: End-to-end smoke (real claude session)**

  ```bash
  /home/jiangzhuo/Desktop/kizunaai/sesshin/packages/cli/bin/sesshin claude
  # In claude, run a one-line prompt and exit. Then:
  curl -s http://127.0.0.1:9663/api/sessions
  # Should show one session entry; events should have arrived via hooks.
  ```

- [ ] **Step 3: Tag**

  ```bash
  git tag M7
  ```

---

## Milestone M8: CLI bidirectional — input injection, raw stream tee, sink stream

### Task 55: PTY tap (CLI side) — tee output to hub `/api/sessions/:id/raw`

**Files:**
- Create: `packages/cli/src/pty-tap.ts`

- [ ] **Step 1: Implement (no separate unit test — covered by integration smoke in M10)**

  ```typescript
  // packages/cli/src/pty-tap.ts
  import { request } from 'node:http';

  /** Stream raw PTY chunks to the hub. Reuses a single keep-alive connection per session. */
  export function startPtyTap(opts: { hubUrl: string; sessionId: string }): { writeChunk(data: string): void; close(): void } {
    const url = new URL(opts.hubUrl);
    const port = Number(url.port);
    let queue: Buffer[] = [];
    let req: ReturnType<typeof request> | null = null;

    const open = (): void => {
      req = request({
        method: 'POST', host: url.hostname, port,
        path: `/api/sessions/${opts.sessionId}/raw`,
        headers: { 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' },
      });
      req.on('error', () => { req = null; });
    };

    open();
    return {
      writeChunk(data) {
        const buf = Buffer.from(data, 'utf-8');
        if (req && !(req as any).destroyed) { req.write(buf); }
        else { queue.push(buf); if (queue.length > 64) queue.shift(); /* drop oldest */ }
      },
      close() { if (req) { req.end(); req = null; } },
    };
  }
  ```

  Note: this is a simplified version that opens one streaming POST per session. Production might want chunked POSTs; for v1 this is sufficient.

- [ ] **Step 2: Wire it in `claude.ts` runClaude**

  ```typescript
  import { startPtyTap } from './pty-tap.js';
  // ...after wrap = wrapPty(...) :
  const tap = startPtyTap({ hubUrl: HUB_URL, sessionId });
  wrap.onData((d) => tap.writeChunk(d));
  // and in onShutdown: tap.close();
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add packages/cli/src/pty-tap.ts packages/cli/src/claude.ts
  git commit -m "cli: PTY tap — tee output to hub /api/sessions/:id/raw"
  ```

### Task 56: Inject listener (sink-stream) — receive input from hub and write to PTY

**Files:**
- Create: `packages/cli/src/inject-listener.ts`

- [ ] **Step 1: Implement**

  ```typescript
  // packages/cli/src/inject-listener.ts
  import { request, type IncomingMessage } from 'node:http';

  /**
   * Open a long-lived NDJSON stream to the hub's sink-stream endpoint.
   * Each line is { data: string, source: string }; we forward `data` into the
   * provided write callback (typically the PTY).
   */
  export interface InjectListenerOpts {
    hubUrl: string;
    sessionId: string;
    onInput: (data: string, source: string) => void;
  }

  export function startInjectListener(opts: InjectListenerOpts): { close(): void } {
    const url = new URL(opts.hubUrl);
    let closed = false;
    let req: ReturnType<typeof request> | null = null;
    const open = (): void => {
      if (closed) return;
      req = request({
        method: 'POST', host: url.hostname, port: Number(url.port),
        path: `/api/sessions/${opts.sessionId}/sink-stream`,
        headers: { 'content-type': 'application/json', 'connection': 'keep-alive' },
      }, (res: IncomingMessage) => {
        let buf = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk) => {
          buf += chunk;
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
            if (!line.trim()) continue;
            try {
              const j = JSON.parse(line);
              if (typeof j.data === 'string' && typeof j.source === 'string') opts.onInput(j.data, j.source);
            } catch { /* ignore malformed line */ }
          }
        });
        res.on('end', () => { if (!closed) setTimeout(open, 500); });
      });
      req.on('error', () => { if (!closed) setTimeout(open, 1000); });
      req.write('{}'); req.end();
    };
    open();
    return { close() { closed = true; req?.destroy(); } };
  }
  ```

- [ ] **Step 2: Wire it in `claude.ts`**

  ```typescript
  import { startInjectListener } from './inject-listener.js';
  // ...
  const inject = startInjectListener({ hubUrl: HUB_URL, sessionId, onInput: (data, _src) => wrap.write(data) });
  // and in onShutdown: inject.close();
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add packages/cli/src/inject-listener.ts packages/cli/src/claude.ts
  git commit -m "cli: inject-listener — long-lived sink-stream → PTY stdin"
  ```

### Task 57: M8 milestone checkpoint + smoke

- [ ] **Step 1: All tests pass**

  ```bash
  pnpm test
  ```

- [ ] **Step 2: End-to-end test via curl + WS**

  ```bash
  /home/jiangzhuo/Desktop/kizunaai/sesshin/packages/cli/bin/sesshin claude &
  CLI_PID=$!
  sleep 2
  # Discover session id
  SID=$(curl -s http://127.0.0.1:9663/api/sessions | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['id'])")
  echo "session: $SID"
  # Send input via WS as a debug-web client
  node -e "
    import('ws').then(({ default: WS }) => {
      const ws = new WS('ws://127.0.0.1:9662/v1/ws');
      ws.on('open', () => {
        ws.send(JSON.stringify({ type:'client.identify', protocol:1, client:{ kind:'debug-web', version:'0', capabilities:['actions'] } }));
        setTimeout(() => ws.send(JSON.stringify({ type:'input.action', sessionId:'$SID', action:'continue' })), 200);
        setTimeout(() => ws.close(), 800);
      });
    });
  "
  # The 'continue' action ('\n') should reach the PTY; claude should respond.
  kill $CLI_PID 2>/dev/null
  ```

  Expected: a newline arrives in the running claude session.

- [ ] **Step 3: Tag**

  ```bash
  git tag M8
  ```

---

## Milestone M9: `@sesshin/debug-web`

### Task 58: debug-web package skeleton (Vite + Preact)

**Files:**
- Create: `packages/debug-web/{package.json,tsconfig.json,vite.config.ts,index.html,src/main.tsx,src/App.tsx}`

- [ ] **Step 1: `packages/debug-web/package.json`**

  ```json
  {
    "name": "@sesshin/debug-web",
    "version": "0.0.0",
    "type": "module",
    "private": true,
    "scripts": {
      "build": "vite build",
      "dev":   "vite",
      "test":  "vitest run",
      "test:watch": "vitest"
    },
    "dependencies": {
      "@sesshin/shared": "workspace:*",
      "preact": "^10.24.0",
      "@preact/signals": "^1.3.0"
    },
    "devDependencies": {
      "@preact/preset-vite": "^2.9.0",
      "vite": "^5.4.0",
      "vitest": "^2.1.0",
      "happy-dom": "^15.0.0"
    }
  }
  ```

- [ ] **Step 2: `packages/debug-web/tsconfig.json`**

  ```json
  {
    "extends": "../../tsconfig.base.json",
    "compilerOptions": {
      "outDir": "dist",
      "rootDir": "src",
      "jsx": "react-jsx",
      "jsxImportSource": "preact",
      "lib": ["ES2023", "DOM", "DOM.Iterable"],
      "moduleResolution": "Bundler"
    },
    "include": ["src/**/*"]
  }
  ```

- [ ] **Step 3: `packages/debug-web/vite.config.ts`**

  ```typescript
  import { defineConfig } from 'vite';
  import preact from '@preact/preset-vite';
  export default defineConfig({
    plugins: [preact()],
    build: { outDir: 'dist', emptyOutDir: true, target: 'es2020' },
    test: { environment: 'happy-dom', globals: false },
  });
  ```

- [ ] **Step 4: `packages/debug-web/index.html`**

  ```html
  <!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>sesshin debug</title>
    </head>
    <body>
      <div id="app"></div>
      <script type="module" src="/src/main.tsx"></script>
    </body>
  </html>
  ```

- [ ] **Step 5: `packages/debug-web/src/main.tsx`**

  ```typescript
  import { render } from 'preact';
  import { App } from './App.js';
  render(<App />, document.getElementById('app')!);
  ```

- [ ] **Step 6: Stub `App.tsx` + commit**

  ```typescript
  // packages/debug-web/src/App.tsx
  export function App() {
    return <main><h1>sesshin</h1><p>debug web (T59+ adds content)</p></main>;
  }
  ```

  ```bash
  pnpm install
  cd packages/debug-web && pnpm build
  ls dist/  # should have index.html, assets/...
  cd ../..
  git add packages/debug-web/ pnpm-lock.yaml
  git commit -m "debug-web: Vite + Preact skeleton"
  ```

### Task 59: WS client wrapper + state store

**Files:**
- Create: `packages/debug-web/src/ws-client.ts`, `packages/debug-web/src/store.ts`

- [ ] **Step 1: `packages/debug-web/src/store.ts`**

  ```typescript
  import { signal, computed } from '@preact/signals';
  import type { SessionInfo, Summary, Event } from '@sesshin/shared';

  export const sessions = signal<SessionInfo[]>([]);
  export const selectedSessionId = signal<string | null>(null);
  export const summariesBySession = signal<Record<string, Summary[]>>({});
  export const eventsBySession = signal<Record<string, Event[]>>({});
  export const connected = signal<boolean>(false);
  export const lastEventId = signal<string | null>(null);

  export const selectedSession = computed(() => sessions.value.find((s) => s.id === selectedSessionId.value) ?? null);

  export function upsertSession(s: SessionInfo): void {
    const existing = sessions.value;
    const idx = existing.findIndex((x) => x.id === s.id);
    sessions.value = idx >= 0
      ? existing.map((x, i) => (i === idx ? s : x))
      : [...existing, s];
  }
  export function removeSession(id: string): void { sessions.value = sessions.value.filter((s) => s.id !== id); }

  export function addSummary(s: Summary & { sessionId: string }): void {
    const cur = summariesBySession.value[s.sessionId] ?? [];
    summariesBySession.value = { ...summariesBySession.value, [s.sessionId]: [s as any, ...cur].slice(0, 50) };
  }
  export function addEvent(e: Event): void {
    const cur = eventsBySession.value[e.sessionId] ?? [];
    eventsBySession.value = { ...eventsBySession.value, [e.sessionId]: [e, ...cur].slice(0, 200) };
    lastEventId.value = e.eventId;
  }
  ```

- [ ] **Step 2: `packages/debug-web/src/ws-client.ts`**

  ```typescript
  import {
    connected, sessions, upsertSession, removeSession,
    addSummary, addEvent, lastEventId,
  } from './store.js';
  import type { Action } from '@sesshin/shared';

  export interface WsClient {
    sendAction(sessionId: string, action: Action): void;
    sendText(sessionId: string, text: string): void;
    close(): void;
  }

  export function connect(): WsClient {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/v1/ws`;
    let ws: WebSocket | null = null;
    let backoff = 500;

    const open = (): void => {
      ws = new WebSocket(url);
      ws.addEventListener('open', () => {
        connected.value = true; backoff = 500;
        ws!.send(JSON.stringify({
          type: 'client.identify', protocol: 1,
          client: { kind: 'debug-web', version: '0.0.0',
            capabilities: ['summary','events','raw','actions','state','attention'] },
        }));
        ws!.send(JSON.stringify({ type: 'subscribe', sessions: 'all', since: lastEventId.value }));
      });
      ws.addEventListener('message', (e) => handleFrame(JSON.parse(e.data)));
      ws.addEventListener('close', () => { connected.value = false; setTimeout(open, backoff); backoff = Math.min(backoff * 2, 10_000); });
      ws.addEventListener('error', () => ws?.close());
    };
    open();

    return {
      sendAction(sessionId, action) { ws?.send(JSON.stringify({ type: 'input.action', sessionId, action })); },
      sendText(sessionId, text) { ws?.send(JSON.stringify({ type: 'input.text', sessionId, text })); },
      close() { ws?.close(); },
    };
  }

  function handleFrame(m: any): void {
    switch (m.type) {
      case 'server.hello': return;
      case 'server.ping': /* (server.pong handler if hub adds one in v1.5) */ return;
      case 'session.list':    sessions.value = m.sessions; return;
      case 'session.added':   upsertSession(m.session); return;
      case 'session.removed': removeSession(m.sessionId); return;
      case 'session.state':   {
        const cur = sessions.value.find((s) => s.id === m.sessionId);
        if (cur) upsertSession({ ...cur, state: m.state, substate: m.substate });
        return;
      }
      case 'session.summary': addSummary(m); return;
      case 'session.event':   addEvent(m); return;
      // raw and attention are accepted but not rendered yet (T64).
    }
  }
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add packages/debug-web/src/store.ts packages/debug-web/src/ws-client.ts
  git commit -m "debug-web: WS client + Preact-signals store"
  ```

### Task 60: SessionList component

**Files:**
- Create: `packages/debug-web/src/components/SessionList.tsx`, `packages/debug-web/src/components/SessionList.test.tsx`

- [ ] **Step 1: Test (happy-dom)**

  ```typescript
  // packages/debug-web/src/components/SessionList.test.tsx
  import { describe, it, expect } from 'vitest';
  import { render } from 'preact';
  import { SessionList } from './SessionList.js';
  import { sessions, selectedSessionId } from '../store.js';

  describe('SessionList', () => {
    it('renders one row per session', () => {
      const div = document.createElement('div');
      sessions.value = [
        { id: 's1', name: 'a', agent: 'claude-code', cwd: '/a', pid: 1, startedAt: 0, state: 'idle', substate: { currentTool: null, lastTool: null, lastFileTouched: null, lastCommandRun: null, elapsedSinceProgressMs: 0, tokensUsedTurn: null, connectivity: 'ok', stalled: false }, lastSummaryId: null },
        { id: 's2', name: 'b', agent: 'claude-code', cwd: '/b', pid: 2, startedAt: 0, state: 'running', substate: { currentTool: 'Edit', lastTool: null, lastFileTouched: null, lastCommandRun: null, elapsedSinceProgressMs: 0, tokensUsedTurn: null, connectivity: 'ok', stalled: false }, lastSummaryId: null },
      ];
      render(<SessionList />, div);
      const rows = div.querySelectorAll('[data-testid="session-row"]');
      expect(rows.length).toBe(2);
    });
    it('clicking a row updates selectedSessionId', () => {
      const div = document.createElement('div');
      sessions.value = [
        { id: 's1', name: 'a', agent: 'claude-code', cwd: '/a', pid: 1, startedAt: 0, state: 'idle', substate: { currentTool: null, lastTool: null, lastFileTouched: null, lastCommandRun: null, elapsedSinceProgressMs: 0, tokensUsedTurn: null, connectivity: 'ok', stalled: false }, lastSummaryId: null },
      ];
      render(<SessionList />, div);
      (div.querySelector('[data-testid="session-row"]') as HTMLElement).click();
      expect(selectedSessionId.value).toBe('s1');
    });
  });
  ```

- [ ] **Step 2: Implement**

  ```typescript
  // packages/debug-web/src/components/SessionList.tsx
  import { sessions, selectedSessionId } from '../store.js';

  export function SessionList() {
    return (
      <ul data-testid="session-list" style={{ listStyle: 'none', padding: 0 }}>
        {sessions.value.map((s) => (
          <li key={s.id}
              data-testid="session-row"
              onClick={() => (selectedSessionId.value = s.id)}
              style={{
                padding: '8px',
                cursor: 'pointer',
                background: selectedSessionId.value === s.id ? '#222' : '#111',
                color: '#fff', borderBottom: '1px solid #333',
              }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span><b>{s.name}</b></span>
              <span data-testid="state-badge">{s.state}</span>
            </div>
            <div style={{ fontSize: '12px', opacity: 0.7 }}>{s.cwd}</div>
            {s.substate.currentTool && <div style={{ fontSize: '12px' }}>tool: {s.substate.currentTool}</div>}
          </li>
        ))}
      </ul>
    );
  }
  ```

- [ ] **Step 3: Run + commit**

  ```bash
  pnpm test
  git add packages/debug-web/src/components/SessionList.tsx packages/debug-web/src/components/SessionList.test.tsx
  git commit -m "debug-web: SessionList component"
  ```

### Task 61: SessionDetail (state badge + summary card)

**Files:**
- Create: `packages/debug-web/src/components/StateBadge.tsx`, `packages/debug-web/src/components/SummaryCard.tsx`, `packages/debug-web/src/components/SessionDetail.tsx`

- [ ] **Step 1: StateBadge.tsx**

  ```typescript
  import type { SessionState } from '@sesshin/shared';
  const COLORS: Record<SessionState, string> = {
    starting: '#888', idle: '#5a5', running: '#5cf',
    'awaiting-input': '#fc5', 'awaiting-confirmation': '#f95',
    error: '#f55', done: '#888', interrupted: '#888',
  };
  export function StateBadge({ state }: { state: SessionState }) {
    return <span data-testid="state-badge" style={{ padding: '2px 8px', borderRadius: 4, background: COLORS[state], color: '#000' }}>{state}</span>;
  }
  ```

- [ ] **Step 2: SummaryCard.tsx**

  ```typescript
  import type { Summary } from '@sesshin/shared';
  export function SummaryCard({ summary }: { summary: Summary | null }) {
    if (!summary) return <div data-testid="no-summary" style={{ padding: 12, opacity: 0.5 }}>no summary yet</div>;
    return (
      <div data-testid="summary-card" style={{ padding: 12, border: '1px solid #333', borderRadius: 6, marginBottom: 12 }}>
        <div style={{ fontSize: 16, marginBottom: 6 }}>{summary.oneLine}</div>
        {summary.bullets.length > 0 && (
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {summary.bullets.map((b, i) => <li key={i}>{b}</li>)}
          </ul>
        )}
        {summary.suggestedNext && <div style={{ marginTop: 8, fontStyle: 'italic' }}>→ {summary.suggestedNext}</div>}
        {summary.needsDecision && <div data-testid="needs-decision" style={{ marginTop: 8, color: '#fc5' }}>(awaiting decision)</div>}
      </div>
    );
  }
  ```

- [ ] **Step 3: SessionDetail.tsx**

  ```typescript
  import { selectedSession, summariesBySession, eventsBySession } from '../store.js';
  import { StateBadge } from './StateBadge.js';
  import { SummaryCard } from './SummaryCard.js';
  import { EventTimeline } from './EventTimeline.js';
  import { ActionButtons } from './ActionButtons.js';
  import { TextInput } from './TextInput.js';
  import type { WsClient } from '../ws-client.js';

  export function SessionDetail({ ws }: { ws: WsClient }) {
    const s = selectedSession.value;
    if (!s) return <div style={{ padding: 24, opacity: 0.5 }}>select a session</div>;
    const summaries = summariesBySession.value[s.id] ?? [];
    const events = eventsBySession.value[s.id] ?? [];
    return (
      <div style={{ padding: 16, color: '#eee' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>{s.name}</h2>
          <StateBadge state={s.state} />
        </div>
        <SummaryCard summary={summaries[0] ?? null} />
        <ActionButtons ws={ws} sessionId={s.id} />
        <TextInput ws={ws} sessionId={s.id} />
        <h3>Event timeline</h3>
        <EventTimeline events={events} />
      </div>
    );
  }
  ```

- [ ] **Step 4: Commit (component tests for StateBadge / SummaryCard inline if helpful, or rely on M10 e2e)**

  ```bash
  git add packages/debug-web/src/components/
  git commit -m "debug-web: StateBadge + SummaryCard + SessionDetail"
  ```

### Task 62: EventTimeline + ActionButtons + TextInput

**Files:**
- Create: `packages/debug-web/src/components/EventTimeline.tsx`, `packages/debug-web/src/components/ActionButtons.tsx`, `packages/debug-web/src/components/TextInput.tsx`

- [ ] **Step 1: EventTimeline.tsx**

  ```typescript
  import type { Event } from '@sesshin/shared';
  export function EventTimeline({ events }: { events: Event[] }) {
    return (
      <ul style={{ listStyle: 'none', padding: 0, fontFamily: 'monospace', fontSize: 12 }}>
        {events.map((e) => (
          <li key={e.eventId} data-testid="event-row" style={{ padding: '2px 4px', borderBottom: '1px solid #222' }}>
            <span style={{ opacity: 0.5 }}>{new Date(e.ts).toLocaleTimeString()}</span>{' '}
            <b>{e.kind}</b>{' '}
            <span style={{ opacity: 0.7 }}>[{e.source}]</span>{' '}
            <code>{shorten(JSON.stringify(e.payload), 80)}</code>
          </li>
        ))}
      </ul>
    );
  }
  function shorten(s: string, n: number): string { return s.length > n ? s.slice(0, n) + '…' : s; }
  ```

- [ ] **Step 2: ActionButtons.tsx**

  ```typescript
  import type { Action } from '@sesshin/shared';
  import type { WsClient } from '../ws-client.js';
  const ACTIONS: Action[] = ['approve','reject','continue','stop','retry','fix','summarize','details','ignore','snooze'];
  export function ActionButtons({ ws, sessionId }: { ws: WsClient; sessionId: string }) {
    return (
      <div style={{ marginBottom: 12 }} data-testid="action-buttons">
        {ACTIONS.map((a) => (
          <button key={a} onClick={() => ws.sendAction(sessionId, a)}
                  style={{ marginRight: 6, padding: '4px 10px', background: '#222', color: '#eee', border: '1px solid #444' }}>
            {a}
          </button>
        ))}
      </div>
    );
  }
  ```

- [ ] **Step 3: TextInput.tsx**

  ```typescript
  import { useRef } from 'preact/hooks';
  import type { WsClient } from '../ws-client.js';
  export function TextInput({ ws, sessionId }: { ws: WsClient; sessionId: string }) {
    const inputRef = useRef<HTMLTextAreaElement>(null);
    return (
      <div style={{ marginBottom: 12 }}>
        <textarea ref={inputRef} placeholder="message claude…" rows={3}
          style={{ width: '100%', background: '#111', color: '#eee', border: '1px solid #444', padding: 6 }} />
        <button data-testid="send-text"
          onClick={() => { const v = inputRef.current?.value ?? ''; if (v.trim()) { ws.sendText(sessionId, v + '\n'); if (inputRef.current) inputRef.current.value = ''; } }}
          style={{ padding: '4px 12px', background: '#246', color: '#fff', border: 0 }}>Send</button>
      </div>
    );
  }
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add packages/debug-web/src/components/
  git commit -m "debug-web: EventTimeline + ActionButtons + TextInput"
  ```

### Task 63: App composition + connect

**Files:**
- Modify: `packages/debug-web/src/App.tsx`

- [ ] **Step 1: Replace App.tsx**

  ```typescript
  import { useState } from 'preact/hooks';
  import { connect } from './ws-client.js';
  import { connected } from './store.js';
  import { SessionList } from './components/SessionList.js';
  import { SessionDetail } from './components/SessionDetail.js';
  import type { WsClient } from './ws-client.js';

  let _ws: WsClient | null = null;

  export function App() {
    if (!_ws) _ws = connect();
    return (
      <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', height: '100vh', background: '#0a0a0a', color: '#eee' }}>
        <aside style={{ borderRight: '1px solid #222', overflowY: 'auto' }}>
          <header style={{ padding: 12, borderBottom: '1px solid #222' }}>
            <b>sesshin</b>{' '}
            <span style={{ marginLeft: 8, color: connected.value ? '#5a5' : '#a55' }}>{connected.value ? '●' : '○'}</span>
          </header>
          <SessionList />
        </aside>
        <main style={{ overflowY: 'auto' }}>
          <SessionDetail ws={_ws} />
        </main>
      </div>
    );
  }
  ```

- [ ] **Step 2: Build + commit**

  ```bash
  cd packages/debug-web && pnpm build
  ls dist/  # index.html + assets
  cd ../..
  git add packages/debug-web/src/App.tsx
  git commit -m "debug-web: App composition (sidebar + detail) wired to WS"
  ```

### Task 64: Bundle SPA into hub at build time

**Files:**
- Modify: `packages/hub/tsup.config.ts`, `packages/hub/src/wire.ts`

- [ ] **Step 1: Modify hub `tsup.config.ts` to copy SPA after build**

  ```typescript
  // packages/hub/tsup.config.ts
  import { defineConfig } from 'tsup';
  import { cpSync, existsSync, mkdirSync } from 'node:fs';
  import { join } from 'node:path';

  export default defineConfig({
    entry: ['src/main.ts', 'src/agents/claude/session-file-path.ts'],
    format: ['esm'], target: 'node22', clean: true, sourcemap: true,
    onSuccess: async () => {
      const spaSrc = join(__dirname, '..', 'debug-web', 'dist');
      const spaDst = join(__dirname, 'dist', 'web');
      if (existsSync(spaSrc)) {
        mkdirSync(spaDst, { recursive: true });
        cpSync(spaSrc, spaDst, { recursive: true });
      }
    },
  });
  ```

- [ ] **Step 2: Point hub's WS server at the SPA dir in `wire.ts`**

  ```typescript
  // In wire.ts, replace the `staticDir: null` with:
  import { fileURLToPath } from 'node:url';
  import { dirname, join } from 'node:path';
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const staticDir = join(__dirname, 'web');

  const ws = createWsServer({
    registry, bus: dedupedBus, tap, staticDir,
    onInput: ...
  });
  ```

- [ ] **Step 3: Update root `package.json` build script to build debug-web before hub**

  ```json
  "scripts": {
    "build": "pnpm --filter @sesshin/shared build && pnpm --filter @sesshin/hook-handler build && pnpm --filter @sesshin/debug-web build && pnpm --filter @sesshin/hub build && pnpm --filter @sesshin/cli build"
  }
  ```

- [ ] **Step 4: Build + manual sanity**

  ```bash
  pnpm build
  ls packages/hub/dist/web/   # index.html + assets/
  packages/hub/bin/sesshin-hub &
  HUB_PID=$!
  sleep 0.5
  curl -s http://127.0.0.1:9662/ | grep -i 'sesshin'
  kill $HUB_PID
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add packages/hub/tsup.config.ts packages/hub/src/wire.ts package.json
  git commit -m "build: bundle debug-web SPA into hub dist/web/, hub serves it at /"
  ```

### Task 65: M9 milestone checkpoint

- [ ] **Step 1: All tests pass**

  ```bash
  pnpm test
  ```

- [ ] **Step 2: Manual end-to-end**

  ```bash
  pnpm build
  packages/cli/bin/sesshin claude
  # In another terminal:
  open http://127.0.0.1:9662/   # macOS  (or `xdg-open` on Linux)
  ```

  In the browser: select the session, watch state badge, type a prompt in claude, see summary appear, click "approve" — `y\n` should reach claude.

- [ ] **Step 3: Tag**

  ```bash
  git tag M9
  ```

---

## Milestone M10: Stub-claude e2e + README + release-ready

### Task 66: Stub-claude binary

**Files:**
- Create: `tests/e2e/stub-claude/{package.json,index.mjs}`

- [ ] **Step 1: `tests/e2e/stub-claude/index.mjs`**

  ```javascript
  #!/usr/bin/env node
  // A fake `claude` for e2e tests. Reads --settings and a prompt from argv,
  // invokes the configured hook handler with synthetic events, and writes a
  // session JSONL like real claude does. Reads stdin for "y" / "n".
  import { readFileSync, mkdirSync, appendFileSync } from 'node:fs';
  import { spawnSync } from 'node:child_process';
  import { homedir } from 'node:os';
  import { join, dirname } from 'node:path';

  const argv = process.argv.slice(2);
  const settingsIdx = argv.indexOf('--settings');
  const settingsPath = settingsIdx >= 0 ? argv[settingsIdx + 1] : null;
  if (!settingsPath) { process.stderr.write('stub-claude: --settings required\n'); process.exit(2); }
  const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));

  const hookCmd = settings.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command;
  const hookEnv = settings.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.env ?? {};
  const sessionId = hookEnv.SESSHIN_SESSION_ID ?? 'stub-session';

  const cwd = process.cwd();
  const encoded = cwd.replaceAll('/', '-');
  const sessionFile = join(homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
  mkdirSync(dirname(sessionFile), { recursive: true });

  function fireHook(event, payload) {
    const cmd = (settings.hooks[event]?.[0]?.hooks?.[0]?.command ?? '').split(' ');
    if (cmd.length === 0) return;
    const env = { ...process.env, ...(settings.hooks[event][0].hooks[0].env ?? {}) };
    spawnSync(cmd[0], cmd.slice(1), { input: JSON.stringify(payload), env, encoding: 'utf-8' });
  }

  function writeJsonl(line) { appendFileSync(sessionFile, JSON.stringify(line) + '\n'); }

  // Synthetic conversation: read first user prompt from argv, then simulate.
  const prompt = argv.find((a) => !a.startsWith('-')) ?? 'do a thing';
  fireHook('SessionStart', { hook_event_name: 'SessionStart' });
  writeJsonl({ type: 'user', message: { content: prompt }, timestamp: new Date().toISOString() });
  fireHook('UserPromptSubmit', { hook_event_name: 'UserPromptSubmit', prompt });

  setTimeout(() => {
    fireHook('PreToolUse',  { hook_event_name: 'PreToolUse',  tool_name: 'Read', tool_input: { path: '/etc/hosts' } });
    fireHook('PostToolUse', { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_response: 'localhost' });
    process.stdout.write('I will respond now. Confirm? (y/n) ');
    process.stdin.once('data', (buf) => {
      const got = buf.toString().trim();
      writeJsonl({ type: 'assistant', message: { content: `You said: ${got}` }, timestamp: new Date().toISOString() });
      fireHook('Stop', { hook_event_name: 'Stop', stop_reason: 'end_turn' });
      fireHook('SessionEnd', { hook_event_name: 'SessionEnd' });
      process.exit(0);
    });
  }, 200);
  ```

- [ ] **Step 2: Make executable**

  ```bash
  chmod +x tests/e2e/stub-claude/index.mjs
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add tests/e2e/stub-claude/
  git commit -m "tests: stub-claude binary for e2e flow"
  ```

### Task 67: e2e test driver

**Files:**
- Create: `tests/e2e/run-e2e.mjs`

- [ ] **Step 1: `tests/e2e/run-e2e.mjs`**

  ```javascript
  #!/usr/bin/env node
  import { spawn } from 'node:child_process';
  import { fileURLToPath } from 'node:url';
  import { dirname, join } from 'node:path';
  import { mkdtempSync, rmSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import WS from 'ws';

  const HERE = dirname(fileURLToPath(import.meta.url));
  const STUB_CLAUDE = join(HERE, 'stub-claude', 'index.mjs');
  const ROOT = join(HERE, '..', '..');
  const HUB_BIN  = join(ROOT, 'packages/hub/bin/sesshin-hub');
  const CLI_BIN  = join(ROOT, 'packages/cli/bin/sesshin');
  const HOOK_BIN = join(ROOT, 'packages/hook-handler/bin/sesshin-hook-handler');

  const tmp = mkdtempSync(join(tmpdir(), 'sesshin-e2e-'));
  const env = {
    ...process.env,
    SESSHIN_HUB_BIN: HUB_BIN,
    SESSHIN_HOOK_HANDLER_BIN: HOOK_BIN,
    SESSHIN_CLAUDE_BIN: STUB_CLAUDE,
    HOME: tmp,        // isolate ~/.claude/, ~/.cache/sesshin/
  };

  function fail(msg) { console.error(msg); rmSync(tmp, { recursive: true, force: true }); process.exit(1); }

  async function main() {
    const cli = spawn('node', [CLI_BIN, 'claude', 'do a thing'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
    let cliOut = '';
    cli.stdout.on('data', (d) => { cliOut += d; });

    // wait for hub to be up
    for (let i = 0; i < 50; i++) {
      try { const r = await fetch('http://127.0.0.1:9663/api/health'); if (r.ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }

    // discover session
    const list = await (await fetch('http://127.0.0.1:9663/api/sessions')).json();
    if (list.length !== 1) fail(`expected 1 session, got ${list.length}`);
    const sid = list[0].id;

    // open WS, capture events
    const ws = new WS('ws://127.0.0.1:9662/v1/ws');
    const got = { events: [], summary: false, state: null };
    await new Promise((res) => ws.on('open', res));
    ws.send(JSON.stringify({ type: 'client.identify', protocol: 1, client: { kind: 'debug-web', version: '0', capabilities: ['summary','events','state','actions'] } }));
    ws.send(JSON.stringify({ type: 'subscribe', sessions: 'all', since: null }));
    ws.on('message', (m) => {
      const msg = JSON.parse(m.toString());
      if (msg.type === 'session.event')   got.events.push(msg);
      if (msg.type === 'session.summary') got.summary = true;
      if (msg.type === 'session.state')   got.state = msg.state;
    });

    // wait until stub-claude prompts for confirmation, then send "approve"
    await new Promise((res) => {
      const t = setInterval(() => { if (cliOut.includes('Confirm? (y/n)')) { clearInterval(t); res(); } }, 50);
    });
    ws.send(JSON.stringify({ type: 'input.action', sessionId: sid, action: 'approve' }));

    // wait for cli exit
    await new Promise((res) => cli.on('exit', res));

    // assertions
    if (!got.summary)             fail('no session.summary received');
    if (got.events.length === 0)  fail('no session.event received');
    if (got.state !== 'idle' && got.state !== 'done') fail(`unexpected final state: ${got.state}`);
    if (!cliOut.includes('You said: y')) fail(`stub-claude did not see "y": output was:\n${cliOut}`);

    console.log('e2e PASS');
    ws.close();
    rmSync(tmp, { recursive: true, force: true });
    process.exit(0);
  }

  main().catch((e) => { console.error(e); rmSync(tmp, { recursive: true, force: true }); process.exit(1); });
  ```

- [ ] **Step 2: Add to root scripts**

  ```json
  "scripts": {
    "e2e": "node tests/e2e/run-e2e.mjs"
  }
  ```

- [ ] **Step 3: Run**

  ```bash
  pnpm build
  pnpm e2e
  ```

  Expected: prints `e2e PASS`. The test exercises CLI startup, hub auto-spawn, settings tempfile, hook firing, JSONL tail, summarizer (Mode B′ MUST be mocked away here — see Step 4), state machine, WS broadcast, input arbiter, action map, sink-stream injection.

- [ ] **Step 4: Mock the Mode B′ call for the e2e**

  Since real Anthropic calls cost real money, the e2e bypasses Mode B′:

  - Set env `SESSHIN_SUMMARIZER=heuristic` in the e2e driver, and have the hub honor it by using the heuristic summarizer instead of Mode B′ + B (small change to `wire.ts`):

    ```typescript
    const useHeuristic = process.env['SESSHIN_SUMMARIZER'] === 'heuristic';
    const summarizer = useHeuristic
      ? new Summarizer({ modeBPrime: () => Promise.reject(new Error('disabled')), modeB: () => Promise.reject(new Error('disabled')), heuristicTail: (sid) => tap.snapshot(sid).toString('utf-8') })
      : new Summarizer({ /* real impls as before */ });
    ```

  - Update e2e driver `env` to include `SESSHIN_SUMMARIZER: 'heuristic'`.

- [ ] **Step 5: Re-run pnpm e2e, expect PASS, commit**

  ```bash
  pnpm build && pnpm e2e
  git add tests/e2e/run-e2e.mjs package.json packages/hub/src/wire.ts
  git commit -m "tests: e2e driver — stub-claude → CLI → hub → WS, asserts full flow"
  ```

### Task 68: Update README "Run" + first-run docs

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Append sections to `README.md`**

  Add after the "Documentation" section:

  ```markdown
  ## Run (developer preview)

  Requires Node 22+, pnpm 9+, a working `claude` binary on PATH, and an
  active Claude.ai login (`claude /login`).

  ```bash
  pnpm install
  pnpm build
  pnpm e2e            # offline e2e using stub-claude (no API spend)

  # Real run:
  packages/cli/bin/sesshin claude
  # Then open http://127.0.0.1:9662 in a browser.
  ```

  ## Settings-merge fallback

  In rare cases (verification gate 1 in `docs/validation-log.md` revealed
  this is necessary on your install), set:

  ```
  export SESSHIN_MERGE_USER_HOOKS=1
  ```

  before running `sesshin claude`. The CLI will read your existing
  `~/.claude/settings.json` hooks and compose them with Sesshin's into the
  per-session temp file. User-visible behavior is unchanged.

  ## Log file

  The hub writes to `~/.cache/sesshin/hub.log`. Tail it for diagnostics.
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add README.md
  git commit -m "docs: README run instructions + settings-merge fallback note"
  ```

### Task 69: Final cleanup pass

- [ ] **Step 1: Scan for stale TODOs in newly-written code**

  ```bash
  grep -rnE 'TODO|FIXME|XXX' packages/ tests/ | grep -v node_modules | grep -v dist || echo "clean"
  ```

  Address anything found, or document in a follow-up issue if deferred.

- [ ] **Step 2: Confirm all milestones tagged**

  ```bash
  git tag | sort
  # Expected: M0 (no tag in plan, but tag now if missing) M1 M2 M3 M4 M5 M6 M7 M8 M9
  ```

- [ ] **Step 3: Final smoke**

  ```bash
  pnpm test
  pnpm e2e
  ```

  Both green.

- [ ] **Step 4: Tag M10**

  ```bash
  git tag M10
  ```

### Task 70: Slice complete

The slice is feature-complete. The next slice (Telegram adapter, deferred
in spec §8) becomes a new spec + plan; the WS protocol it consumes is
unchanged.
