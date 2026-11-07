# shellcheck shell=bash
# Account helpers that rome-init.sh and rome-init-tools.sh source. Both run as
# root.

ROME_DOCKER_USER_MODE="${ROME_DOCKER_USER_MODE:-multi}"
ROME_SINGLE_UID_MODE=0
if [ "$ROME_DOCKER_USER_MODE" = "root" ] || ! gosu rome true >/dev/null 2>&1; then
  ROME_SINGLE_UID_MODE=1
  if [ "$ROME_DOCKER_USER_MODE" != "root" ]; then
    echo "Using single-UID Docker mode: gosu cannot switch users in this container."
  fi
fi

safe_chown() {
  if [ "$ROME_SINGLE_UID_MODE" = "1" ]; then
    return 0
  fi
  chown "$@"
}

run_as_account() {
  local username="$1"
  local home_dir="$2"
  shift 2

  if [ "$ROME_SINGLE_UID_MODE" = "1" ]; then
    HOME="$home_dir" USER="$username" LOGNAME="$username" "$@"
    return
  fi

  gosu "$username" env HOME="$home_dir" USER="$username" LOGNAME="$username" "$@"
}

run_as_rome() {
  run_as_account rome /home/rome "$@"
}

run_as_user() {
  run_as_account user /home/user "$@"
}
