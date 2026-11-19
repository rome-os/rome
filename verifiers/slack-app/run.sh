#!/usr/bin/env bash
# Scores the official Slack app on rule set v1, phase 1.
# Usage: verifiers/slack-app/run.sh [--r6-stop <seconds>] [--r12-allow-members] <env.json> [out dir]
# Writes report.json and report.md to the out dir (default: out/<time> here).
# --r6-stop sets how long R6 holds the instance stopped (also
# VERIFIER_R6_STOP_SECONDS). Default: env.json's, else 120. The rule's is 3600.
# --r12-allow-members (or VERIFIER_R12_ALLOW_MEMBERS=1) has R12 turn replies to
# other members on first (PUT /settings), as a guardian would; without it R12
# scores the instance's default.
set -euo pipefail

while [ $# -gt 0 ]; do
  case "$1" in
    --r6-stop)
      export VERIFIER_R6_STOP_SECONDS="${2:?--r6-stop needs a number of seconds}"
      shift 2 ;;
    --r12-allow-members)
      export VERIFIER_R12_ALLOW_MEMBERS=1
      shift ;;
    *) break ;;
  esac
done

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_json="${1:?usage: run.sh [--r6-stop <seconds>] [--r12-allow-members] <env.json> [out dir]}"
out="${2:-$here/out/$(date -u +%Y%m%dT%H%M%SZ)}"

# A report names the verifier commit, so the code that ran must be that commit.
if [ -n "$(git -C "$here" status --porcelain -- .)" ]; then
  echo "refusing to run: verifiers/slack-app has uncommitted changes:" >&2
  git -C "$here" status --short -- . >&2
  exit 2
fi
commit="$(git -C "$here" rev-parse HEAD)"

exec node "$here/verify.mjs" "$env_json" "$out" "$commit"
