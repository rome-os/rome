#!/usr/bin/env bash
# Scores the official Slack app on rule set v1, phase 1.
# Usage: verifiers/slack-app/run.sh [--r6-stop <seconds>] <env.json> [out dir]
# Writes report.json and report.md to the out dir (default: out/<time> here).
# --r6-stop sets how long R6 holds the instance stopped (also
# VERIFIER_R6_STOP_SECONDS). Default: env.json's, else 120. The rule's is 3600.
set -euo pipefail

if [ "${1:-}" = "--r6-stop" ]; then
  export VERIFIER_R6_STOP_SECONDS="${2:?--r6-stop needs a number of seconds}"
  shift 2
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_json="${1:?usage: run.sh [--r6-stop <seconds>] <env.json> [out dir]}"
out="${2:-$here/out/$(date -u +%Y%m%dT%H%M%SZ)}"

# A report names the verifier commit, so the code that ran must be that commit.
if [ -n "$(git -C "$here" status --porcelain -- .)" ]; then
  echo "refusing to run: verifiers/slack-app has uncommitted changes:" >&2
  git -C "$here" status --short -- . >&2
  exit 2
fi
commit="$(git -C "$here" rev-parse HEAD)"

exec node "$here/verify.mjs" "$env_json" "$out" "$commit"
