#!/usr/bin/env bash
# Stops the Slack app test environment and removes its containers, volumes and
# state, including the scratch worktrees. Built Rome images are kept so the
# next start of the same commit is fast; pass --images to remove them too.
set -euo pipefail
ENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="$ENV_DIR/.state"
ROME_DIR="$(git -C "$ENV_DIR" rev-parse --show-toplevel)"
ROME_CLOUD_DIR="${ROME_CLOUD_DIR:-$(dirname "$ROME_DIR")/rome-cloud}"

PROJECT="$(sed -n 's/^SLACKENV_PROJECT=//p' "$STATE_DIR/compose.env" 2>/dev/null || true)"
PROJECT="${PROJECT:-${SLACKENV_PROJECT:-slackenv}}"
if [ -f "$STATE_DIR/compose.env" ]; then
  # Every profile, so the slack-gateway Worker and its forwarders go too.
  docker compose --env-file "$STATE_DIR/compose.env" -f "$ENV_DIR/compose.yml" --profile slack-gateway \
    down -v --remove-orphans
fi
# Nothing of the project may survive: a container left running keeps writing
# into .state and holds the network.
left="$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")"
nets="$(docker network ls -q --filter "label=com.docker.compose.project=$PROJECT")"
if [ -n "$left$nets" ]; then
  echo "[slackenv] compose project $PROJECT still has:" >&2
  [ -z "$left" ] || docker ps -a --filter "label=com.docker.compose.project=$PROJECT" --format '  container {{.Names}} ({{.Status}})' >&2
  [ -z "$nets" ] || docker network ls --filter "label=com.docker.compose.project=$PROJECT" --format '  network {{.Name}}' >&2
  echo "[slackenv] remove them (docker rm -f, docker network rm) and run down.sh again; .state is kept" >&2
  exit 1
fi
if [ "${1:-}" = "--images" ]; then
  # A cloud-only run built no instance image, and finding none is fine.
  docker images --format '{{.Repository}}:{{.Tag}}' | { grep -E '^slackenv-rome(-test)?:' || true; } | xargs -r docker rmi || true
fi
git -C "$ROME_DIR" worktree remove --force "$STATE_DIR/rome-src" 2>/dev/null || true
[ -d "$ROME_CLOUD_DIR" ] && git -C "$ROME_CLOUD_DIR" worktree remove --force "$STATE_DIR/rome-cloud-src" 2>/dev/null || true
# Containers write as the host user, so this needs no root.
rm -rf "$STATE_DIR"
git -C "$ROME_DIR" worktree prune
[ -d "$ROME_CLOUD_DIR" ] && git -C "$ROME_CLOUD_DIR" worktree prune
echo "[slackenv] down"
