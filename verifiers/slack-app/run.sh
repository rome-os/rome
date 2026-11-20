#!/usr/bin/env bash
# Scores the official Slack app on rule set v3, phases 1 to 3.
# Usage: verifiers/slack-app/run.sh [--r6-stop <seconds>] [--only <ids>] [--min-free-gb <n>] <env.json> [out dir]
# Writes report.json and report.md to the out dir (default: out/<time> here).
# --r6-stop sets how long R6 holds the instance stopped (also
# VERIFIER_R6_STOP_SECONDS). Default: env.json's, else 120. The rule's is 3600.
# --only <ids> scores a subset: rule ids or phases, comma separated
# (--only R14, --only phase3); R1 and the second binding always run, since
# the rest need their connections. Rules left out report "not checked".
# --min-free-gb <n> makes each rule wait (up to VERIFIER_MEMORY_WAIT_SECONDS,
# default 1800) while this machine has less than n GB available
# (/proc/meminfo), then report it not checked if it still does.
# R12 scores the connection's own switch for answering members, so the old
# --r12-allow-members is accepted and ignored.
set -euo pipefail

while [ $# -gt 0 ]; do
  case "$1" in
    --r6-stop)
      export VERIFIER_R6_STOP_SECONDS="${2:?--r6-stop needs a number of seconds}"
      shift 2 ;;
    --only)
      export VERIFIER_ONLY="${2:?--only needs rule ids or a phase}"
      shift 2 ;;
    --min-free-gb)
      export VERIFIER_MIN_FREE_GB="${2:?--min-free-gb needs a number}"
      shift 2 ;;
    --r12-allow-members)
      echo "run.sh: --r12-allow-members is ignored; R12 scores the connection's switch" >&2
      shift ;;
    *) break ;;
  esac
done

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_json="${1:?usage: run.sh [--r6-stop <seconds>] [--only <ids>] [--min-free-gb <n>] <env.json> [out dir]}"
out="${2:-$here/out/$(date -u +%Y%m%dT%H%M%SZ)}"

# A report names the verifier commit, so the code that ran must be that commit.
if [ -n "$(git -C "$here" status --porcelain -- .)" ]; then
  echo "refusing to run: verifiers/slack-app has uncommitted changes:" >&2
  git -C "$here" status --short -- . >&2
  exit 2
fi
commit="$(git -C "$here" rev-parse HEAD)"

exec node "$here/verify.mjs" "$env_json" "$out" "$commit"
