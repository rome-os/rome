#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 <stopped-rome-container> <durable-volume> <completion-marker>" >&2
  exit 2
}

[[ $# == 3 ]] || usage

source_container=$1
target_volume=$2
completion_marker=$3
docker_bin=${DOCKER_BIN:-docker}
state_path=/var/lib/tailscale

source_image="$($docker_bin container inspect --format '{{.Image}}' "$source_container")"
[[ -n "$source_image" ]] || {
  echo "Could not resolve the source container image." >&2
  exit 1
}

source_mount="$($docker_bin container inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/tailscale"}}{{if eq .Type "volume"}}{{.Name}}{{else}}{{printf "unsupported:%s:%s" .Type .Source}}{{end}}{{end}}{{end}}' "$source_container")"
if [[ -n "$source_mount" ]]; then
  if [[ "$source_mount" == "$target_volume" ]]; then
    echo "Tailnet state already uses $target_volume."
    exit 0
  fi
  echo "Refusing to replace the existing $state_path mount: $source_mount" >&2
  exit 1
fi

source_id="$($docker_bin container inspect --format '{{.Id}}' "$source_container")"
marker_value="$source_id $target_volume"
if [[ -f "$completion_marker" ]] && [[ "$(cat "$completion_marker")" == "$marker_value" ]]; then
  $docker_bin volume inspect "$target_volume" >/dev/null
  echo "Tailnet state migration is already complete in $target_volume."
  exit 0
fi

if $docker_bin volume inspect "$target_volume" >/dev/null 2>&1; then
  echo "Refusing the unmarked existing volume $target_volume." >&2
  exit 1
fi

helper="rome-tailnet-migration-${source_id:0:12}-$$"
marker_tmp="${completion_marker}.tmp.$$"
created_volume=false
cleanup() {
  local status=$?
  $docker_bin container rm -f "$helper" >/dev/null 2>&1 || true
  rm -f "$marker_tmp"
  if [[ $status != 0 && "$created_volume" == true ]]; then
    $docker_bin volume rm "$target_volume" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT

$docker_bin volume create \
  --label dev.rome.prototype=hosted-tailnet-migration \
  "$target_volume" >/dev/null
created_volume=true

$docker_bin container create \
  --name "$helper" \
  --entrypoint /bin/sh \
  --mount "type=volume,source=$target_volume,destination=$state_path,volume-nocopy" \
  "$source_image" -c ':' >/dev/null

# Docker streams the directory as an archive. The script never decodes or selects
# Tailscale fields, so unknown state files survive the migration as one unit.
$docker_bin container cp "$source_container:$state_path/." - |
  $docker_bin container cp - "$helper:$state_path"

mkdir -p "$(dirname "$completion_marker")"
umask 077
printf '%s\n' "$marker_value" >"$marker_tmp"
mv -f "$marker_tmp" "$completion_marker"
created_volume=false

echo "Copied opaque Tailnet state into $target_volume."
