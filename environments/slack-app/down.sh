#!/usr/bin/env bash
# Stops one copy of the Slack app test environment and removes its containers,
# volumes and state, including the scratch worktrees. Built Rome images are
# kept so the next start of the same commit is fast; pass --images to remove
# this copy's images too.
#
#   environments/slack-app/down.sh [--project <name>] [--images]
#
# --project picks the copy (tools/copy.sh: default $SLACKENV_PROJECT, else
# slackenv). Only that compose project, its state folder and its own image
# names are touched; another copy keeps running.
set -euo pipefail
ENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --project)
      SLACKENV_PROJECT="${2:-}"
      shift 2 || true
      ;;
    --images)
      IMAGES=1
      shift
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done
# shellcheck source=tools/copy.sh
. "$ENV_DIR/tools/copy.sh"
ROME_DIR="$(git -C "$ENV_DIR" rev-parse --show-toplevel)"
ROME_CLOUD_DIR="${ROME_CLOUD_DIR:-$(dirname "$ROME_DIR")/rome-cloud}"

PROJECT="$SLACKENV_PROJECT"
if [ -f "$STATE_DIR/compose.env" ]; then
  # The project compose.env names wins: it is the one that was started.
  PROJECT="$(sed -n 's/^SLACKENV_PROJECT=//p' "$STATE_DIR/compose.env")"
  PROJECT="${PROJECT:-$SLACKENV_PROJECT}"
  # Every profile, so the slack-gateway Worker and its forwarders go too.
  docker compose -p "$PROJECT" --env-file "$STATE_DIR/compose.env" -f "$ENV_DIR/compose.yml" --profile slack-gateway \
    down -v --remove-orphans
fi
# Nothing of the project may survive: a container left running keeps writing
# into its state folder and holds the network.
left="$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")"
nets="$(docker network ls -q --filter "label=com.docker.compose.project=$PROJECT")"
if [ -n "$left$nets" ]; then
  echo "[slackenv] compose project $PROJECT still has:" >&2
  [ -z "$left" ] || docker ps -a --filter "label=com.docker.compose.project=$PROJECT" --format '  container {{.Names}} ({{.Status}})' >&2
  [ -z "$nets" ] || docker network ls --filter "label=com.docker.compose.project=$PROJECT" --format '  network {{.Name}}' >&2
  echo "[slackenv] remove them (docker rm -f, docker network rm) and run down.sh again; $STATE_DIR is kept" >&2
  exit 1
fi
if [ "$IMAGES" = 1 ]; then
  # Only this copy's own names. A cloud-only run built no instance image, and
  # finding none is fine.
  docker images --format '{{.Repository}}:{{.Tag}}' | { grep -E "^$IMAGE_PREFIX-rome(-test)?:" || true; } | xargs -r docker rmi || true
fi
git -C "$ROME_DIR" worktree remove --force "$STATE_DIR/rome-src" 2>/dev/null || true
[ -d "$ROME_CLOUD_DIR" ] && git -C "$ROME_CLOUD_DIR" worktree remove --force "$STATE_DIR/rome-cloud-src" 2>/dev/null || true
# Containers write as the host user, so this needs no root.
rm -rf "$STATE_DIR"
git -C "$ROME_DIR" worktree prune
[ -d "$ROME_CLOUD_DIR" ] && git -C "$ROME_CLOUD_DIR" worktree prune
echo "[slackenv] $PROJECT down"
