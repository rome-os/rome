#!/usr/bin/env bash
# Score the Sessions API. From anywhere in the repo:
#   packages/core/src/test/eval/sessions-api/run.sh            source checks only
#   packages/core/src/test/eval/sessions-api/run.sh --parity   also type check and unit tests
#   ... --parity --baseline                                     record this tree as the baseline
#   ... --tree <path>                                           score another checkout of the repo
set -euo pipefail
core="$(cd "$(dirname "$0")/../../../.." && pwd)"
cd "$core"
pnpm exec tsx src/test/eval/sessions-api/scorecard.ts "$@"
