#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'error: required command not found: %s\n' "$1" >&2
    exit 1
  fi
}

require_cmd node
require_cmd pnpm

printf '==> repo: %s\n' "$ROOT_DIR"
cd "$ROOT_DIR"

printf '==> installing workspace dependencies\n'
pnpm install

printf '==> building workspace packages\n'
pnpm build

printf '==> linking root CLI package globally (sesshin)\n'
pnpm link --global

printf '==> linking hub package globally (sesshin-hub)\n'
cd "$ROOT_DIR/packages/hub"
pnpm link --global
cd "$ROOT_DIR"

printf '\nDone. Linked commands should now resolve to this checkout.\n'
printf 'Verify with:\n'
printf '  command -v sesshin\n'
printf '  command -v sesshin-hub\n'
printf '  sesshin --help || true\n'
printf '  sesshin-hub --help || true\n'
