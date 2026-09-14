#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
smoke_dir="$(mktemp -d)"
smoke_name="rome-host-smoke-$$"
socket_volume="${smoke_name}-socket"
state_volume="${smoke_name}-state"
go_image="${ROME_HOST_TEST_GO_IMAGE:-golang:1.26.7-bookworm}"
node_image="${ROME_HOST_TEST_NODE_IMAGE:-node:24-bookworm-slim}"

cleanup() {
  docker rm -f "$smoke_name" >/dev/null 2>&1 || true
  docker volume rm "$socket_volume" "$state_volume" >/dev/null 2>&1 || true
  rm -rf "$smoke_dir"
}
trap cleanup EXIT

docker run --rm \
  --mount "type=bind,src=$repo_root/packages/host-helper,dst=/src,readonly" \
  --mount "type=bind,src=$smoke_dir,dst=/out" \
  --workdir /src "$go_image" \
  sh -c 'CGO_ENABLED=0 go build -o /out/rome-hostd ./cmd/rome-hostd'

cat >"$smoke_dir/config.json" <<'JSON'
{"hostId":"smoke-vm","enabled":true,"socketPath":"/run/rome-host/control.sock","stateDir":"/var/lib/rome-host","socketGid":10001,"maxTimeoutSeconds":3,"maxOutputBytes":1024}
JSON

docker volume create "$socket_volume" >/dev/null
docker volume create "$state_volume" >/dev/null
docker run -d --name "$smoke_name" --network none \
  --mount "type=bind,src=$smoke_dir,dst=/fixtures,readonly" \
  --mount "type=volume,src=$socket_volume,dst=/run/rome-host" \
  --mount "type=volume,src=$state_volume,dst=/var/lib/rome-host" \
  --env HOST_EXECUTION_TEST_SECRET=not-for-children \
  "$node_image" sh -c \
  'mkdir -p /etc/rome-host && chmod 700 /var/lib/rome-host && cp /fixtures/config.json /etc/rome-host/config.json && chmod 600 /etc/rome-host/config.json && exec /fixtures/rome-hostd --config /etc/rome-host/config.json' >/dev/null

run_client() {
  docker run --rm --network none --user 10001:10001 \
    --mount "type=volume,src=$socket_volume,dst=/run/rome-host,readonly" \
    --mount "type=bind,src=$repo_root/scripts/host-helper,dst=/tests,readonly" \
    "$node_image" node /tests/smoke-client.mjs "$1"
}

run_client exercise
docker restart "$smoke_name" >/dev/null
run_client verify-restart
docker exec "$smoke_name" test -f /var/lib/rome-host/smoke-root-proof
echo 'Host execution smoke passed: nonroot client, root host job, durable deduplication, timeout and cancellation.'
