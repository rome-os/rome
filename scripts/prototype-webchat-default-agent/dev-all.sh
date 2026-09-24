#!/usr/bin/env bash
# PROTOTYPE (webchat-default-agent): run the prototype drivers against this
# worktree's `pnpm dev:all` stack. Everything runs inside the worktree's rome
# container: the API on its loopback :4141, the SPA through Vite on :3000, and
# the Chrome sidecar's CDP on :9222 (the sidecar shares the container's network).
#   scripts/prototype-webchat-default-agent/dev-all.sh scenarios <args...>
#   scripts/prototype-webchat-default-agent/dev-all.sh ui <flow> [a|b] [arg]
#   scripts/prototype-webchat-default-agent/dev-all.sh sh '<command>'
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SLUG="$(cd "$ROOT" && scripts/worktree-slug.sh)"
C="${SLUG}-rome-1"
DIR=scripts/prototype-webchat-default-agent
kind="${1:?usage: dev-all.sh scenarios|ui|sh ...}"; shift
case "$kind" in
  scenarios)
    exec docker exec -e WDA_BASE=http://127.0.0.1:4141 -w /workspace "$C" \
      node "$DIR/scenarios.prototype.mjs" "$@" ;;
  ui)
    exec docker exec -e WDA_BASE=http://127.0.0.1:3000 -e WDA_CDP=http://127.0.0.1:9222 \
      -e WDA_OUT=/tmp/wda/shots -w /workspace "$C" node "$DIR/ui.prototype.mjs" "$@" ;;
  sh)
    exec docker exec -w /workspace "$C" sh -c "$1" ;;
  *) echo "unknown: $kind" >&2; exit 2 ;;
esac
