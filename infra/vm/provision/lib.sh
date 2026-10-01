#!/bin/bash
# Shared by the provision steps. Sourced, not run.

# install_if_changed SRC DST [MODE]: install SRC at DST when the content
# differs, and note the change so run.sh restarts only what moved.
install_if_changed() {
  local src="$1" dst="$2" mode="${3:-0644}"
  if ! cmp -s "$src" "$dst"; then
    install -m "$mode" "$src" "$dst"
    mark_changed "$(basename "$dst")"
  fi
}

# mark_changed NAME: record that NAME changed during this run. run.sh reads
# the marks in apply mode and clears them.
mark_changed() {
  mkdir -p /run/rome-host-changes
  : >"/run/rome-host-changes/$1"
}

changed() {
  [[ -e "/run/rome-host-changes/$1" ]]
}
