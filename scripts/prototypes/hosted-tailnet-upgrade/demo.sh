#!/usr/bin/env bash
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
docker_bin=${DOCKER_BIN:-docker}
$docker_bin compose version >/dev/null

scratch=$(mktemp -d)
suffix="${RANDOM}-$$"
connected_project="rome-tailnet-connected-$suffix"
empty_project="rome-tailnet-empty-$suffix"
connected_volume="${connected_project}-state"
empty_volume="${empty_project}-state"

cleanup() {
  ROME_TAILSCALE_VOLUME="$connected_volume" $docker_bin compose \
    -p "$connected_project" -f "$here/compose.after.yml" down -v --remove-orphans >/dev/null 2>&1 || true
  ROME_TAILSCALE_VOLUME="$empty_volume" $docker_bin compose \
    -p "$empty_project" -f "$here/compose.after.yml" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT

start_before() {
  local project=$1
  $docker_bin compose -p "$project" -f "$here/compose.before.yml" up -d --quiet-pull
  $docker_bin compose -p "$project" -f "$here/compose.before.yml" ps -q rome
}

connected_state_digest() {
  local container=$1
  $docker_bin container exec "$container" sha256sum \
    /var/lib/tailscale/tailscaled.state /var/lib/tailscale/nested/profile.bin
}

connected_container=$(start_before "$connected_project")
$docker_bin container exec "$connected_container" sh -c '
  mkdir -p /var/lib/tailscale/nested
  printf "not-a-real-tailscale-key\000\377\001" > /var/lib/tailscale/tailscaled.state
  printf "opaque-sidecar-data\n" > /var/lib/tailscale/nested/profile.bin
  chmod 600 /var/lib/tailscale/tailscaled.state
'
expected_digest=$(connected_state_digest "$connected_container")
$docker_bin compose -p "$connected_project" -f "$here/compose.before.yml" stop rome >/dev/null
"$here/migrate-tailnet-state.sh" \
  "$connected_container" "$connected_volume" "$scratch/connected.complete"

ROME_TAILSCALE_VOLUME="$connected_volume" $docker_bin compose \
  -p "$connected_project" -f "$here/compose.after.yml" up -d --force-recreate --quiet-pull
replacement_container=$(ROME_TAILSCALE_VOLUME="$connected_volume" $docker_bin compose \
  -p "$connected_project" -f "$here/compose.after.yml" ps -q rome)
[[ "$(connected_state_digest "$replacement_container")" == "$expected_digest" ]]

ROME_FIXTURE_IMAGE=alpine:3.20 ROME_TAILSCALE_VOLUME="$connected_volume" $docker_bin compose \
  -p "$connected_project" -f "$here/compose.after.yml" up -d --force-recreate --quiet-pull
rollback_container=$(ROME_TAILSCALE_VOLUME="$connected_volume" $docker_bin compose \
  -p "$connected_project" -f "$here/compose.after.yml" ps -q rome)
[[ "$(connected_state_digest "$rollback_container")" == "$expected_digest" ]]

empty_container=$(start_before "$empty_project")
$docker_bin compose -p "$empty_project" -f "$here/compose.before.yml" stop rome >/dev/null
"$here/migrate-tailnet-state.sh" "$empty_container" "$empty_volume" "$scratch/empty.complete"
ROME_TAILSCALE_VOLUME="$empty_volume" $docker_bin compose \
  -p "$empty_project" -f "$here/compose.after.yml" up -d --force-recreate --quiet-pull
empty_replacement=$(ROME_TAILSCALE_VOLUME="$empty_volume" $docker_bin compose \
  -p "$empty_project" -f "$here/compose.after.yml" ps -q rome)
[[ -z "$($docker_bin container exec "$empty_replacement" find /var/lib/tailscale -mindepth 1 -print -quit)" ]]

echo "PASS: replacement and rollback kept the opaque state bytes."
echo "PASS: an empty source stayed empty."
