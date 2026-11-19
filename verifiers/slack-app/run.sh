#!/usr/bin/env bash
# Scores the official Slack app on rule set v1, phase 1.
# Usage: verifiers/slack-app/run.sh <env.json> [out dir]
# Writes report.json and report.md to the out dir (default: out/<time> here).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_json="${1:?usage: run.sh <env.json> [out dir]}"
out="${2:-$here/out/$(date -u +%Y%m%dT%H%M%SZ)}"

# A report names the verifier commit, so the code that ran must be that commit.
if [ -n "$(git -C "$here" status --porcelain -- .)" ]; then
  echo "refusing to run: verifiers/slack-app has uncommitted changes:" >&2
  git -C "$here" status --short -- . >&2
  exit 2
fi
commit="$(git -C "$here" rev-parse HEAD)"

exec node "$here/verify.mjs" "$env_json" "$out" "$commit"
