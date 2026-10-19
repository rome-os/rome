#!/usr/bin/env bash
# Run the backend suite end to end: start a throwaway instance, run the cases,
# collect the container log, report anomalies, and scan the output for secrets.
# Exits non-zero when a case fails or the secret scan finds a match.
#
# Environment:
#   ROME_E2E_IMAGE                 image to test (default zoolsher/rome:latest)
#   ROME_E2E_ANTHROPIC_ENV_JSON    model environment, or ..._ENV_FILE for a path
#   MIDSCENE_MODEL_*               Midscene's model, or ROME_E2E_ENV_FILE for a dotenv path
#   ROME_E2E_KEEP=1                leave the instance running afterwards
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
suite=$(cd "$here/.." && pwd)
out=${ROME_E2E_OUT:-$suite/midscene_run/backend}
rm -rf "$out" && mkdir -p "$out"

"$here/instance.sh" up || {
  "$here/instance.sh" collect "$out"
  exit 1
}

export ROME_E2E_BASE_URL="http://127.0.0.1:${ROME_E2E_PORT:-8090}"
export ROME_E2E_EVENTS_FILE="$out/events.jsonl"
(cd "$suite" && npm run -s test:backend)
status=$?

"$here/instance.sh" collect "$out"
image=${ROME_E2E_IMAGE:-zoolsher/rome:latest}
revision=$(docker image inspect "$image" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' || true)
node "$suite/scripts/backend-anomalies.mjs" --rome-log "$out/rome.log" --events "$out/events.jsonl" \
  --image "$image@$revision" --out "$out"
node "$suite/scripts/backend-secret-scan.mjs" "$suite/midscene_run" "$suite/.midscene" || status=1
[ "${ROME_E2E_KEEP:-0}" = 1 ] || "$here/instance.sh" down
exit $status
