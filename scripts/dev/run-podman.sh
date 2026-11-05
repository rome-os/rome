#!/usr/bin/env bash
set -Eeuo pipefail

IMAGE="${IMAGE:-docker.io/yunfanye/rome:latest}"
NAME="${NAME:-rome}"
PORT="${PORT:-8080}"
CURRENT_DIR="${CURRENT_DIR:-$(pwd)}"
BASE="${ROME_DATA_DIR:-$CURRENT_DIR/.rome/rome}"
PODMAN_STORAGE="${PODMAN_STORAGE:-$CURRENT_DIR/.rome/podman-storage}"
MOUNT_MASK_DIR="$CURRENT_DIR/.rome/mount-mask"
PROFILE="${ROME_PROFILE:-default}"

mkdir -p "$BASE"/{app,user_home,rome_home,ssh_host_keys}
mkdir -p "$PODMAN_STORAGE" "$MOUNT_MASK_DIR"

PODMAN=(
  podman
  --root "$PODMAN_STORAGE"
  --storage-driver overlay
  --storage-opt overlay.ignore_chown_errors=true
)

"${PODMAN[@]}" pull "$IMAGE"

"${PODMAN[@]}" stop "$NAME" >/dev/null 2>&1 || true
"${PODMAN[@]}" rm -f "$NAME" >/dev/null 2>&1 || true

"${PODMAN[@]}" run -d \
  --name "$NAME" \
  --privileged \
  -p "${PORT}:8080" \
  -e NODE_ENV=production \
  -e WEB_HOST=0.0.0.0 \
  -e TS_HOSTNAME=rome \
  -e ROME_PROFILE="$PROFILE" \
  -e ROME_START_TIMEOUT_MS=300000 \
  -e ROME_DOCKER_USER_MODE=root \
  -e ROME_CHROME_DISABLE_SANDBOX=1 \
  -v "$BASE/app:/app" \
  -v "$BASE/user_home:/home/user" \
  -v "$BASE/rome_home:/home/rome" \
  -v "$BASE/ssh_host_keys:/etc/ssh/ssh_host_keys" \
  -v "$CURRENT_DIR:/home/rome/.rome/$PROFILE/projects/mount" \
  -v "$MOUNT_MASK_DIR:/home/rome/.rome/$PROFILE/projects/mount/.rome:ro" \
  "$IMAGE"

"${PODMAN[@]}" image prune -f

echo "Rome starting on http://127.0.0.1:${PORT}"
echo "Health: curl http://127.0.0.1:${PORT}/api/health"
