#!/usr/bin/env bash
# Append a suite's native Midscene result to the job Summary.
#
#   tests/midscene/scripts/write-summary.sh <suite>
#
# result.md links the HTML report by a path relative to the runner, which does
# not resolve from the Summary; the publish job links the Pages copy instead.
set -euo pipefail

suite=$1
results=$(dirname "$0")/../.midscene/test-results
{
  found=""
  for result in "$results"/*/result.md; do
    [ -f "$result" ] || continue
    found=1
    sed -e "s/^## Midscene Test\$/## Midscene suite: $suite/" \
      -e '/^\[Open the Midscene Test report ↗\](/d' "$result"
  done
  if [ -z "$found" ]; then
    echo "## Midscene suite: $suite"
    echo
    echo "The suite wrote no result; see the job log."
  fi
  echo
  echo "[Download the suite artifact]($GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID#artifacts)"
} >>"$GITHUB_STEP_SUMMARY"
