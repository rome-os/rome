#!/bin/bash
# Runs a command as the rome or user account with that account's HOME, USER and
# LOGNAME, replacing this process so a supervisor signals the command itself.
# In single-UID mode gosu cannot switch users, so the command keeps the current
# user. rome-init.sh detects the mode the same way.
#
# Usage: rome-run-as <rome|user> <command> [args...]
set -euo pipefail

account="$1"
shift

if [ "${ROME_DOCKER_USER_MODE:-multi}" = "root" ] || ! gosu "$account" true >/dev/null 2>&1; then
  exec env HOME="/home/$account" USER="$account" LOGNAME="$account" "$@"
fi
exec gosu "$account" env HOME="/home/$account" USER="$account" LOGNAME="$account" "$@"
