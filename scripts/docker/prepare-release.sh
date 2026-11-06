#!/usr/bin/env bash
set -euo pipefail

target_sha="$(git rev-parse HEAD)"

case "$GITHUB_EVENT_NAME" in
  push)
    if [[ "$GITHUB_REF" != refs/tags/v* ]]; then
      echo "::error::Docker releases require a v* tag."
      exit 1
    fi
    tag="${GITHUB_REF#refs/tags/}"
    ;;
  schedule | workflow_dispatch)
    if [[ "$GITHUB_REF" != refs/heads/main || "$target_sha" != "$GITHUB_SHA" ]]; then
      echo "::error::Scheduled and manual releases must use the triggering main commit."
      exit 1
    fi

    # A rerun keeps its original version even if another release has since landed.
    marker="rome-scheduled-release:${GITHUB_RUN_ID}"
    tag="$(git for-each-ref --format='%(refname:strip=2) %(contents:subject)' refs/tags/ |
      awk -v marker="$marker" '$2 == marker { print $1 }')"
    if [[ -n "$tag" ]]; then
      target_sha="$(git rev-parse "${tag}^{commit}")"
      if ! git merge-base --is-ancestor "$target_sha" "$GITHUB_SHA"; then
        echo "::error::The scheduled release tag points at a commit outside this branch."
        exit 1
      fi
    else
      # Runs are listed newest first. A commit merged after this run started can
      # already be green, so only commits in this run's history qualify.
      green_shas="$(gh api "repos/${GITHUB_REPOSITORY}/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=100" \
        --jq '.workflow_runs[].head_sha')"
      target_sha=""
      for sha in $green_shas; do
        if git merge-base --is-ancestor "$sha" "$GITHUB_SHA" 2>/dev/null; then
          target_sha="$sha"
          break
        fi
      done
      if [[ -z "$target_sha" ]]; then
        echo "::error::No commit in the history of ${GITHUB_SHA} has passed CI. No release tag was created."
        exit 1
      fi
      # A person who starts a run expects the commit they started it on.
      if [[ "$GITHUB_EVENT_NAME" == workflow_dispatch && "$target_sha" != "$GITHUB_SHA" ]]; then
        echo "::error::CI for ${GITHUB_SHA} has not passed. No release tag was created."
        exit 1
      fi

      latest_tag="$(git tag --list --sort=-version:refname |
        awk '/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/ && !found { print; found = 1 }')"
      if [[ -z "$latest_tag" ]]; then
        echo "::error::No stable vMAJOR.MINOR.PATCH tag exists."
        exit 1
      fi
      if [[ "$target_sha" != "$GITHUB_SHA" ]] && git merge-base --is-ancestor "$target_sha" "$latest_tag"; then
        echo "::error::The newest green commit ${target_sha} is already in ${latest_tag}. No release tag was created."
        exit 1
      fi
      IFS='.' read -r major minor patch <<<"${latest_tag#v}"
      tag="v${major}.${minor}.$((patch + 1))"

      git -c user.name='github-actions[bot]' \
        -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
        tag -a "$tag" "$target_sha" -m "$marker"
      # GITHUB_TOKEN does not trigger another push workflow. This run publishes it.
      git push origin "refs/tags/${tag}"
    fi
    ;;
  *)
    echo "::error::Unsupported release event: ${GITHUB_EVENT_NAME}"
    exit 1
    ;;
esac

{
  echo "tag=${tag}"
  echo "sha=${target_sha}"
} >>"$GITHUB_OUTPUT"

if [[ "$target_sha" != "$GITHUB_SHA" ]]; then
  echo "::warning::${tag} releases ${target_sha}, not the newest main commit ${GITHUB_SHA}, whose CI has not passed."
fi
echo "Release ${tag} from ${target_sha}"
