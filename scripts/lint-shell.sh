#!/usr/bin/env bash
# Lint the repo's shell scripts with shellcheck + shfmt.
#
# Usage:
#   scripts/lint-shell.sh          # check (shellcheck + shfmt -d); non-zero on findings
#   scripts/lint-shell.sh --write  # apply shfmt formatting in place, then shellcheck
#
# This is the single source of truth for the tool flags so CI, the devShell,
# and ad-hoc local runs all agree. Targets every git-tracked *.sh file.
#
# Install the tools from the nix devShell (`nix develop`) or your package
# manager: both `shellcheck` and `shfmt` must be on PATH.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# shfmt: 2-space indent (-i 2) and indented case branches (-ci), matching the
# repo's existing shell style and the 2-space JS/TS formatting (biome.json).
SHFMT_FLAGS=(-i 2 -ci)
# Static analysis flags: -x follows `source`d files; --severity=warning fails on
# warnings and errors but not the noisier info/style tier (e.g. SC2329
# false-positives on functions only invoked indirectly via `"$@"`).
SHELLCHECK_FLAGS=(-x --severity=warning)

write=0
if [ "${1:-}" = "--write" ] || [ "${1:-}" = "--fix" ]; then
  write=1
fi

# Read the file list into an array so paths with spaces survive. Include
# untracked-but-not-ignored files so a brand-new script is linted before it is
# ever committed (and so does not slip past CI on the PR that adds it). s6
# names a service's scripts run, finish and data/check, with no extension.
mapfile -t files < <(git ls-files --cached --others --exclude-standard '*.sh' \
  'scripts/docker/s6-rc.d/*/run' 'scripts/docker/s6-rc.d/*/finish' \
  'scripts/docker/s6-rc.d/*/data/check')
if [ "${#files[@]}" -eq 0 ]; then
  echo "lint-shell: no *.sh files tracked" >&2
  exit 0
fi

for tool in shellcheck shfmt; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "lint-shell: '$tool' not found on PATH — run inside \`nix develop\` or install it" >&2
    exit 127
  fi
done

status=0

if [ "$write" -eq 1 ]; then
  echo "lint-shell: formatting ${#files[@]} script(s) with shfmt ..."
  shfmt "${SHFMT_FLAGS[@]}" -w "${files[@]}"
else
  echo "lint-shell: checking ${#files[@]} script(s) with shfmt ..."
  if ! shfmt "${SHFMT_FLAGS[@]}" -d "${files[@]}"; then
    echo "lint-shell: shfmt found formatting issues — run \`pnpm format:sh\` to fix" >&2
    status=1
  fi
fi

echo "lint-shell: checking ${#files[@]} script(s) with shellcheck ..."
if ! shellcheck "${SHELLCHECK_FLAGS[@]}" "${files[@]}"; then
  status=1
fi

exit "$status"
