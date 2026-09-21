#!/usr/bin/env bash
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

mkdir -p "$scratch/bin" "$scratch/containers/connected/var/lib/tailscale/nested" \
  "$scratch/containers/empty/var/lib/tailscale" "$scratch/volumes" "$scratch/helpers"
printf 'not-a-real-tailscale-key\000\377\001' > \
  "$scratch/containers/connected/var/lib/tailscale/tailscaled.state"
printf 'opaque-sidecar-data\n' > \
  "$scratch/containers/connected/var/lib/tailscale/nested/profile.bin"

cat >"$scratch/bin/docker" <<'FAKE_DOCKER'
#!/usr/bin/env bash
set -euo pipefail
root=${FAKE_DOCKER_ROOT:?}
kind=$1
command=$2
shift 2

case "$kind $command" in
  "container inspect")
    [[ $1 == --format ]]
    format=$2
    container=$3
    case "$format" in
      *'.Image'*) printf 'fixture-image\n' ;;
      *'.Id'*) printf '%064s\n' "$container" | tr ' ' 0 ;;
      *'.Mounts'*)
        if [[ -f "$root/containers/$container.mount" ]]; then
          cat "$root/containers/$container.mount"
        fi
        ;;
      *) exit 64 ;;
    esac
    ;;
  "volume inspect")
    [[ -d "$root/volumes/$1" ]]
    ;;
  "volume create")
    while [[ $1 == --label ]]; do shift 2; done
    mkdir "$root/volumes/$1"
    printf '%s\n' "$1"
    ;;
  "volume rm")
    rm -rf "$root/volumes/$1"
    ;;
  "container create")
    helper=
    mount=
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --name) helper=$2; shift 2 ;;
        --entrypoint) shift 2 ;;
        --mount) mount=$2; shift 2 ;;
        *) shift ;;
      esac
    done
    volume=${mount#*source=}
    volume=${volume%%,*}
    printf '%s\n' "$volume" >"$root/helpers/$helper"
    printf '%s\n' "$helper"
    ;;
  "container cp")
    if [[ $1 == - ]]; then
      helper=${2%%:*}
      volume=$(cat "$root/helpers/$helper")
      tar -C "$root/volumes/$volume" -xf -
    else
      container=${1%%:*}
      tar -C "$root/containers/$container/var/lib/tailscale" -cf - .
    fi
    ;;
  "container rm")
    [[ $1 == -f ]]
    rm -f "$root/helpers/$2"
    ;;
  *)
    echo "unexpected fake Docker command: $kind $command $*" >&2
    exit 64
    ;;
esac
FAKE_DOCKER
chmod +x "$scratch/bin/docker"

export DOCKER_BIN="$scratch/bin/docker"
export FAKE_DOCKER_ROOT="$scratch"

bash -n "$here/migrate-tailnet-state.sh" "$here/demo.sh" "$here/test.sh"

"$here/migrate-tailnet-state.sh" connected connected-state "$scratch/connected.complete"
diff -r "$scratch/containers/connected/var/lib/tailscale" "$scratch/volumes/connected-state"

printf 'must-not-overwrite\n' >"$scratch/containers/connected/var/lib/tailscale/tailscaled.state"
"$here/migrate-tailnet-state.sh" connected connected-state "$scratch/connected.complete"
grep -a -q 'not-a-real-tailscale-key' "$scratch/volumes/connected-state/tailscaled.state"

"$here/migrate-tailnet-state.sh" empty empty-state "$scratch/empty.complete"
[[ -z "$(find "$scratch/volumes/empty-state" -mindepth 1 -print -quit)" ]]

printf 'connected-state\n' >"$scratch/containers/replacement.mount"
mkdir -p "$scratch/containers/replacement/var/lib/tailscale"
"$here/migrate-tailnet-state.sh" replacement connected-state "$scratch/replacement.complete"

echo "PASS: copied opaque bytes, reused completed state, and kept an empty source empty."
echo "PASS: a replacement that mounts the durable volume needs no migration."
