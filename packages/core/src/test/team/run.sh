#!/usr/bin/env bash
# Scores the product in this checkout on rules 1 and 2 of "A team can share one
# Rome" and writes out/report.json and out/summary.md. Run inside the devShell:
#
#   nix develop -c packages/core/src/test/team/run.sh [--proofs]
#
# --proofs also runs the verifier against its stand-ins (proofs.verify.ts).
# Exits 0 when every rule passes, 1 when one fails, 2 when it refuses to run.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
folder="packages/core/src/test/team"
web_file="packages/web/src/pages/SettingsTabPage.team.verify.tsx"

dirty="$(git -C "$repo" status --porcelain --untracked-files=all -- . \
  ":(exclude)$folder" ":(exclude)$web_file")"
if [ -n "$dirty" ]; then
  echo "Refusing to run: product code has uncommitted changes:" >&2
  echo "$dirty" >&2
  exit 2
fi

rm -rf "$here/out"
mkdir -p "$here/out"

# The verifiers record verdicts in out/ and the merge reads them, so a failing
# rule is not a failing command here.
(cd "$repo/packages/core" && pnpm test run --include "src/test/team/team.verify.ts") \
  >"$here/out/core.log" 2>&1 || true
(cd "$repo/packages/web" && pnpm test run --include "src/pages/SettingsTabPage.team.verify.tsx") \
  >"$here/out/web.log" 2>&1 || true
if [ "${1:-}" = "--proofs" ]; then
  (cd "$repo/packages/core" && pnpm test run --include "src/test/team/proofs.verify.ts") \
    >"$here/out/proofs.log" 2>&1 || echo "proofs failed: see out/proofs.log" >&2
fi

exec node "$here/merge-report.mjs" "$repo" "$folder" "$web_file"
