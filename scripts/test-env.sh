#!/usr/bin/env bash

# Run tests with a small, explicit environment. Runtime configuration, service
# credentials, and NODE_ENV from the invoking shell must not silently change
# test behavior.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "Usage: scripts/test-env.sh <command> [args...]" >&2
  exit 2
fi

path_value="${PATH:-/usr/local/bin:/usr/bin:/bin}"
home_value="${HOME:-/tmp}"
tmp_value="${TMPDIR:-/tmp}"

test_env=(
  "PATH=${path_value}"
  "HOME=${home_value}"
  "TMPDIR=${tmp_value}"
  "TMP=${tmp_value}"
  "TEMP=${tmp_value}"
  "NODE_ENV=test"
  "TZ=UTC"
  "LANG=C"
  "LC_ALL=C"
)

# Preserve runner context, not arbitrary application configuration. Test runners
# use CI to reject `.only`, and GITHUB_ACTIONS to emit workflow annotations.
[ -n "${CI:-}" ] && test_env+=("CI=true")
[ -n "${GITHUB_ACTIONS:-}" ] && test_env+=("GITHUB_ACTIONS=true")

# Keep non-interactive output deterministic without degrading local watch mode.
if [ -t 1 ]; then
  [ -n "${TERM:-}" ] && test_env+=("TERM=${TERM}")
  [ -n "${COLORTERM:-}" ] && test_env+=("COLORTERM=${COLORTERM}")
  [ -n "${NO_COLOR:-}" ] && test_env+=("NO_COLOR=${NO_COLOR}")
  [ -n "${FORCE_COLOR:-}" ] && test_env+=("FORCE_COLOR=${FORCE_COLOR}")
else
  test_env+=("TERM=dumb" "NO_COLOR=1")
fi

exec env -i "${test_env[@]}" "$@"
