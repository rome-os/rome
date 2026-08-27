#!/usr/bin/env bash
# Build a Rome image from the monorepo, load it into Lima, and launch the Mac app.
set -euo pipefail

TAG="rome-local:dev"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
LIMACTL="$SCRIPT_DIR/../lima/bin/limactl"
# Match the LIMA_HOME the desktop sets in lima.ts:resolveLimaHome().
export LIMA_HOME="$HOME/.rome-desktop/runtime/lima"

rome_status=$("$LIMACTL" list --format '{{.Name}}|{{.Status}}' 2>/dev/null | grep '^rome|' || true)
if [ -z "$rome_status" ]; then
  echo "Lima 'rome' instance not found at $LIMA_HOME." >&2
  echo "Launch the desktop once to provision it, then re-run:" >&2
  echo "  pnpm dev:desktop" >&2
  exit 1
fi
if [ "${rome_status#rome|}" != "Running" ]; then
  echo "Starting Lima 'rome' (currently ${rome_status#rome|})..."
  "$LIMACTL" start --tty=false rome
fi

BUILD_SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker build --platform "linux/$(uname -m | sed s/x86_64/amd64/)" \
  --build-arg "ROME_BUILD_SHA=$BUILD_SHA" \
  --build-arg "ROME_BUILD_TIME=$BUILD_TIME" \
  -t "$TAG" "$REPO_ROOT"
# `sudo`, because containerd in the guest runs as root under OpenRC. Without it
# nerdctl takes the rootless path, looks for a socket under $XDG_RUNTIME_DIR
# that is never there, and exits with "rootless containerd not running?" — after
# the image has already built, so the failure costs a full rebuild to retry.
# Every nerdctl call the app itself makes is sudo'd (runtime/providers/lima.ts).
docker save "$TAG" | "$LIMACTL" shell --workdir=/ rome sudo nerdctl --namespace=rome load

ROME_DESKTOP_IMAGE="$TAG" pnpm dev --filter=rome-desktop
