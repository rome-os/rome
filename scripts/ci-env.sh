#!/usr/bin/env bash

# Run a command inside the flake's CI shell, so CI uses the toolchain
# flake.nix declares rather than whatever the runner happens to preinstall.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "Usage: scripts/ci-env.sh <command> [args...]" >&2
  exit 2
fi

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

# --no-write-lock-file makes a flake.nix input that drifts from flake.lock fail
# here instead of silently re-locking and running CI against unpinned inputs.
exec nix develop --no-write-lock-file "${repo_root}#ci" --command "$@"
