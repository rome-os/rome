#!/usr/bin/env bash
# Stops the Slack app test environment and removes its containers, volumes and
# state, including the scratch worktrees. Built Rome images are kept so the
# next start of the same commit is fast; pass --images to remove them too.
set -euo pipefail
ENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="$ENV_DIR/.state"
ROME_DIR="$(git -C "$ENV_DIR" rev-parse --show-toplevel)"
ROME_CLOUD_DIR="${ROME_CLOUD_DIR:-$(dirname "$ROME_DIR")/rome-cloud}"

if [ -f "$STATE_DIR/compose.env" ]; then
  docker compose --env-file "$STATE_DIR/compose.env" -f "$ENV_DIR/compose.yml" down -v --remove-orphans
fi
if [ "${1:-}" = "--images" ]; then
  # A cloud-only run built no instance image, and finding none is fine.
  docker images --format '{{.Repository}}:{{.Tag}}' | { grep '^slackenv-rome:' || true; } | xargs -r docker rmi
fi
git -C "$ROME_DIR" worktree remove --force "$STATE_DIR/rome-src" 2>/dev/null || true
[ -d "$ROME_CLOUD_DIR" ] && git -C "$ROME_CLOUD_DIR" worktree remove --force "$STATE_DIR/rome-cloud-src" 2>/dev/null || true
# Containers write as the host user, so this needs no root.
rm -rf "$STATE_DIR"
git -C "$ROME_DIR" worktree prune
[ -d "$ROME_CLOUD_DIR" ] && git -C "$ROME_CLOUD_DIR" worktree prune
echo "[slackenv] down"
