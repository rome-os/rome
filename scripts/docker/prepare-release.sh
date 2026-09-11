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
  schedule)
    if [[ "$GITHUB_REF" != refs/heads/main || "$target_sha" != "$GITHUB_SHA" ]]; then
      echo "::error::Scheduled releases must use the triggering main commit."
      exit 1
    fi

    # A rerun keeps its original version even if another release has since landed.
    marker="rome-scheduled-release:${GITHUB_RUN_ID}"
    tag="$(git for-each-ref --format='%(refname:strip=2) %(contents:subject)' refs/tags/ |
      awk -v marker="$marker" '$2 == marker { print $1 }')"
    if [[ -n "$tag" ]]; then
      if [[ "$(git rev-parse "${tag}^{commit}")" != "$target_sha" ]]; then
        echo "::error::The scheduled release tag points at a different commit."
        exit 1
      fi
    else
      ci="$(gh api "repos/${GITHUB_REPOSITORY}/actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${target_sha}&per_page=1" \
        --jq '.workflow_runs[0] | "\(.status):\(.conclusion)"')"
      if [[ "$ci" != completed:success ]]; then
        echo "::error::CI for ${target_sha} is ${ci}. No release tag was created."
        exit 1
      fi

      latest_tag="$(git tag --list --sort=-version:refname |
        awk '/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/ && !found { print; found = 1 }')"
      if [[ -z "$latest_tag" ]]; then
        echo "::error::No stable vMAJOR.MINOR.PATCH tag exists."
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

echo "Release ${tag} from ${target_sha}"
