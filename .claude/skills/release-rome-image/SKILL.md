---
name: release-rome-image
description: Release a new Rome runtime image by pushing a `vX.Y.Z` tag — pick the version, verify main is releasable, push the tag, and confirm the image published to Docker Hub. Covers the `v*` runtime-image tag only, not the desktop app (`desktop-v*`) and not npm packages (`ui-v*`, `app-runtime-v*`).
disable-model-invocation: true
---

# Release a new Rome image

A pushed `vX.Y.Z` tag is the release. `.github/workflows/docker-publish.yml` builds the multi-arch image and publishes it to `yunfanye/rome`, with no approval gate between the push and Docker Hub. Get explicit confirmation before the push. Verify the published image after it.

The tagging contract covering the semver gate, tag immutability, and `latest` movement lives in [docs/releases.md](../../../docs/releases.md#tagging-contract).

## Out of scope

- Desktop releases use the `desktop-v*` tag and a separate pipeline.
- npm package releases belong to release-please. Never create those tags by hand.

## 1. Preflight

The tag lands on `origin/main`, and `docker-publish.yml` runs no CI gate of its own.

1. Read the commit that the tag will point at.

   ```bash
   git fetch origin --tags && git rev-parse origin/main
   ```

2. List the recent CI runs.

   ```bash
   gh run list --branch main --workflow CI --limit 5
   ```

3. Find the run for the exact commit from step 1 and confirm the status is `success`. CI cancels superseded runs, so a rapid series of merges leaves `cancelled` runs on real commits. If the run failed, was cancelled, or is still running, stop and report it.

4. Confirm no release is already in flight.

   ```bash
   gh run list --workflow docker-publish.yml --limit 3
   ```

## 2. Pick the version

1. Read the current stable tags.

   ```bash
   git tag --list 'v[0-9]*' | sort -V | tail -5
   ```

2. For a patch release, use the helper in step 3. The helper computes the next patch version.
3. For a minor or major release, take the version from the user.
4. For a prerelease, use `vX.Y.Z-rc.N`. A prerelease publishes its own docker tag and never moves `latest`.

Two constraints decide the number. A published version is immutable, so re-pushing a released version fails and the fix for a bad release is the next version up. `latest` moves only when the new version is the highest stable version in the registry.

## 3. Cut the tag

For a patch release:

1. Print the planned tag and target commit.

   ```bash
   scripts/dev/create-patch-release-tag.sh --dry-run
   ```

2. Show that output to the user and wait for an explicit yes.
3. Create and push the tag, which starts the publish.

   ```bash
   scripts/dev/create-patch-release-tag.sh
   ```

For a minor, major, or prerelease version, the helper does not apply, because it bumps the patch version only. Confirm the version with the user, then tag `origin/main` directly.

```bash
git tag -a v1.1.0 origin/main -m "Release v1.1.0" && git push origin refs/tags/v1.1.0
```

## 4. Verify the publish

1. Watch the run to completion.

   ```bash
   gh run watch "$(gh run list --workflow docker-publish.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
   ```

2. Confirm the version reached the registry.

   ```bash
   curl -fsSL "https://hub.docker.com/v2/repositories/yunfanye/rome/tags?page_size=20" | jq -r '.results[].name'
   ```

3. Read the notes the `notes` job generated from the merged PR titles.

   ```bash
   gh release view vX.Y.Z
   ```

   The notes are editable on GitHub, and the job never overwrites an edit. If a PR title reads badly in the list, fix it there. [docs/releases.md](../../../docs/releases.md#release-notes) covers what the job decides on its own.

4. Report the published version, whether `latest` moved, the build SHA, and the release URL. A running instance reports the baked version at `/api/build-info`.
