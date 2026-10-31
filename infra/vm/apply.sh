#!/usr/bin/env bash
# Bring a live host up to this tree's host layer. Same scripts the image
# build runs, over SSH instead of inside a disk file. Idempotent: applying
# to a host built from the same tree changes nothing.
#
#   infra/vm/apply.sh [--wechat|--no-wechat] [--hostd PATH] user@host [-- ssh options...]
#
# Everything after `--` goes to ssh verbatim, so both `-p 22` and `-v` work.
# The user needs passwordless sudo. --hostd installs or replaces the host
# helper binary. --wechat enables it and personal WeChat on this host, and
# stays on for later applies; --no-wechat turns both off again.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
wechat=""
hostd=""
ssh_args=()
target=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --wechat)
      wechat=on
      shift
      ;;
    --no-wechat)
      wechat=off
      shift
      ;;
    --hostd)
      hostd="$2"
      shift 2
      ;;
    --)
      shift
      ssh_args=("$@")
      break
      ;;
    *)
      [[ -z "$target" ]] || {
        echo "apply.sh: unexpected argument $1 (ssh options go after --)" >&2
        exit 2
      }
      target="$1"
      shift
      ;;
  esac
done
[[ -n "$target" ]] || {
  echo "usage: apply.sh [--wechat] [--hostd PATH] user@host [-- ssh options]" >&2
  exit 2
}

run() { ssh ${ssh_args[@]+"${ssh_args[@]}"} "$target" "$@"; }

# The tree replaces what the host had, so a file removed from the tree is
# removed from the host too. Per-host state (the wechat marker, applied,
# config.json) lives beside the tree and is kept. Modes are not the
# developer's: run.sh normalizes the tree before anything runs from it.
tar -C "$here" -c pins.env provision files |
  run 'sudo rm -rf /etc/rome-host/provision /etc/rome-host/files && sudo mkdir -p /etc/rome-host && sudo tar -x -C /etc/rome-host --no-same-owner --no-same-permissions'
case "$wechat" in
  on) run 'sudo touch /etc/rome-host/wechat' ;;
  off) run 'sudo rm -f /etc/rome-host/wechat /opt/rome/docker-compose.override.yml' ;;
esac
if [[ -n "$hostd" ]]; then
  run 'sudo tee /etc/rome-host/rome-hostd >/dev/null' <"$hostd"
fi
run 'sudo bash /etc/rome-host/provision/run.sh apply'
