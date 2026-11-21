#!/usr/bin/env bash
# Scores the official Slack app on rule set v4: R1 to R11 and R14, each a
# promise the Slack connection keeps, checked at its edges. A smoke check (a
# direct message gets a reply) runs outside the score.
# Usage: verifiers/slack-app/run.sh [--worker] [--r6-stop <seconds>] [--only <ids>] [--min-free-gb <n>] <env.json> [out dir]
# Writes report.json and report.md to the out dir (default: out/<time> here).
# --r6-stop sets how long R6 holds the instance stopped (also
# VERIFIER_R6_STOP_SECONDS). Default: env.json's, else 120. The rule's is 3600.
# --only <ids> scores a subset: rule ids or groups, comma separated
# (--only R14, --only hear); R1 and the second binding always run, since
# the rest need their connections. Rules left out report "not checked".
# --min-free-gb <n> makes each rule wait (up to VERIFIER_MEMORY_WAIT_SECONDS,
# default 1800) while this machine has less than n GB available
# (/proc/meminfo), then report it not checked if it still does.
# R12 is no longer a rule, so the old --r12-allow-members is accepted and
# ignored.
# --worker scores rule set v5 on the slack-gateway Worker's side instead,
# with the verifier's stand-in instance (gateway/agent.mjs) run as each
# instance through the environment's as_instance control (worker.mjs).
set -euo pipefail

while [ $# -gt 0 ]; do
  case "$1" in
    --r6-stop)
      export VERIFIER_R6_STOP_SECONDS="${2:?--r6-stop needs a number of seconds}"
      shift 2 ;;
    --only)
      export VERIFIER_ONLY="${2:?--only needs rule ids or a group}"
      shift 2 ;;
    --min-free-gb)
      export VERIFIER_MIN_FREE_GB="${2:?--min-free-gb needs a number}"
      shift 2 ;;
    --worker)
      entry=worker.mjs
      shift ;;
    --r12-allow-members)
      echo "run.sh: --r12-allow-members is ignored; R12 is no longer a rule" >&2
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

# v5: Rome Cloud answers https under the environment's own CA, which Node
# reads only at start.
trust="$(node -e 'try{const e=require(process.argv[1]);const t=e.rome_cloud?.trust_pem;if(t)process.stdout.write(require("path").resolve(require("path").dirname(process.argv[1]),t))}catch{}' "$(realpath "$env_json")")"
if [ -n "$trust" ] && [ -f "$trust" ]; then export NODE_EXTRA_CA_CERTS="$trust"; fi

exec node "$here/${entry:-verify.mjs}" "$env_json" "$out" "$commit"
