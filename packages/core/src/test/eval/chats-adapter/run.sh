#!/usr/bin/env bash
# Run the Chats and adapter eval and print its scorecard. From anywhere in
# the repo: packages/core/src/test/eval/chats-adapter/run.sh
set -euo pipefail
core="$(cd "$(dirname "$0")/../../../.." && pwd)"
cd "$core"
../../scripts/test-env.sh pnpm exec rstest chats-adapter/boundary.eval
pnpm exec tsx src/test/eval/chats-adapter/scorecard.ts
