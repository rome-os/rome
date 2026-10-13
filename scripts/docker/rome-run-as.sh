#!/bin/bash
# Runs a command as the rome or user account with that account's HOME, USER,
# LOGNAME and PATH, replacing this process so a supervisor signals the command
# itself. In single-UID mode gosu cannot switch users, so the command keeps the
# current user. rome-init.sh detects the mode the same way.
#
# Usage: rome-run-as <rome|user> [--log <path>] <command> [args...]
set -euo pipefail

account="$1"
shift

if [ "${1:-}" = "--log" ]; then
  log="$2"
  shift 2
  # The account must open the log, so a symlink cannot pass it a root-opened fd.
  set -- /bin/bash -c 'log="$1"; shift; exec "$@" >>"$log" 2>&1' bash "$log" "$@"
fi

# The account's ~/.local/bin, where its npm and uv installs land, comes last, so
# nothing installed there can stand in for a command the image ships. Only the
# account's own processes get it. Root services keep the image's PATH.
path="${PATH:+$PATH:}/home/$account/.local/bin"
case ":${PATH:-}:" in
  *":/home/$account/.local/bin:"*) path="$PATH" ;;
esac

if [ "${ROME_DOCKER_USER_MODE:-multi}" = "root" ] || ! gosu "$account" true >/dev/null 2>&1; then
  exec env HOME="/home/$account" USER="$account" LOGNAME="$account" PATH="$path" "$@"
fi
exec gosu "$account" env HOME="/home/$account" USER="$account" LOGNAME="$account" PATH="$path" "$@"
