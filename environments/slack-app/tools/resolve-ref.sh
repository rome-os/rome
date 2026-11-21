#!/usr/bin/env bash
# Prints the commit a ref names in a repo: resolve-ref.sh <repo> <ref>.
# An origin/<branch> ref is fetched first, into origin/<branch> itself, so it
# resolves in a single-branch clone too, whose fetch refspec covers one branch.
set -euo pipefail
repo="$1" ref="$2"
case "$ref" in
  origin/*)
    branch="${ref#origin/}"
    git -C "$repo" fetch -q origin "+refs/heads/$branch:refs/remotes/origin/$branch" || {
      echo "cannot fetch $ref in $repo" >&2
      exit 1
    }
    ;;
esac
git -C "$repo" rev-parse --verify -q "$ref^{commit}" || {
  echo "$ref is not a commit in $repo" >&2
  exit 1
}
