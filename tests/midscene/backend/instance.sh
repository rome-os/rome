#!/usr/bin/env bash
# Start, collect, and stop the throwaway Rome instance for the backend suite.
#   instance.sh up        start from empty volumes and wait for `needs-account`
#   instance.sh collect D write the container log into directory D
#   instance.sh down      stop and delete the instance and its volumes
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

PROJECT=${ROME_E2E_COMPOSE_PROJECT:-rome-e2e}
PORT=${ROME_E2E_PORT:-8090}
export ROME_E2E_PORT=$PORT ROME_DOCKER_APP_CODE_MODE=${ROME_DOCKER_APP_CODE_MODE:-compiled}
compose() {
  docker compose -p "$PROJECT" -f docker-compose.yml -f tests/midscene/backend/compose.override.yml "$@"
}

case "${1:-}" in
  up)
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    compose up -d --no-build rome
    start=$(date +%s)
    until compose logs rome 2>&1 | grep -q "Rome started"; do
      state=$(docker inspect -f '{{.State.Status}}' "$(compose ps -aq rome)")
      [ "$state" = running ] || {
        echo "rome container is $state" >&2
        exit 1
      }
      (($(date +%s) - start < 600)) || {
        echo "timed out waiting for Rome started" >&2
        exit 1
      }
      sleep 5
    done
    phase=$(curl -fsS "http://127.0.0.1:$PORT/api/bootstrap")
    echo "Rome started after $(($(date +%s) - start))s; bootstrap: $phase"
    grep -q '"needs-account"' <<<"$phase"
    ;;
  collect)
    out=${2:?output directory}
    mkdir -p "$out"
    compose logs --no-color --timestamps rome >"$out/rome.log" 2>&1 || true
    ;;
  down)
    compose down -v --remove-orphans
    ;;
  *)
    sed -n '2,5p' "$0" >&2
    exit 2
    ;;
esac
