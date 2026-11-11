# Releases

Rome ships three kinds of release artifacts: the **runtime Docker image** (the product), the **Mac app**, and **npm SDK packages** (for app authors). They have independent versioning and independent pipelines.

## Rome runtime image (Docker Hub)

The runtime image is released through [`.github/workflows/docker-publish.yml`](../.github/workflows/docker-publish.yml), on a `v*` tag push, a weekday schedule, or a manual run. It builds multi-arch (amd64 + arm64) images and publishes to the repository named by `IMAGE_NAME` in that workflow. A stable release uses `vMAJOR.MINOR.PATCH`, and a prerelease appends `-rc.N`.

### Scheduled patch releases

The workflow starts every Monday through Friday at 08:30 in `America/Los_Angeles`, including during daylight saving time. GitHub can delay scheduled runs when its runners are busy.

Each scheduled run increments the patch component of the highest stable git tag, even when `main` has no new commits. For example, `v1.1.9` becomes `v1.1.10`. Prerelease and package tags do not affect that choice.

The release uses the newest commit in the history of the `main` commit that triggered the schedule whose push CI run succeeded. When that is not the triggering commit, because the triggering commit's CI is unfinished, failed, or cancelled, the run page shows a warning that names both commits. The run creates no tag when no commit has passed CI, or when the newest one that has is already in the highest stable tag.

The scheduled run creates an annotated tag with `GITHUB_TOKEN` and publishes it in the same run. No additional token or repository secret is required. All production Docker publish runs share one concurrency group, so version allocation and `latest` updates run serially.

Rerunning a scheduled run reuses its original tag. To retry a failed build or publish, rerun the failed jobs. The [tagging contract](#tagging-contract) rejects any attempt to overwrite an image version that already exists.

A manual run allocates its version the same way, but never falls back to an older commit. Start it from the workflow's **Run workflow** button on `main`. It bumps the patch version of the latest `main` commit after that commit's CI passes, and fails without creating a tag until then. A run started from any other branch also fails without creating a tag.

### Manual releases

To cut a patch release, start a manual run as described above. For a minor, major, or prerelease version, push the tag yourself. The steps for cutting a manual release — preflight, version choice, the confirmed push, and verification — live in the [`release-rome-image`](../.claude/skills/release-rome-image/SKILL.md) skill. Follow it rather than running the helper directly.

`scripts/dev/create-patch-release-tag.sh` is a planning aid the skill calls with `--dry-run` to compute the next patch version, not a release command. It accepts `--remote`, `--branch`, `--prefix`, and the matching `ROME_RELEASE_*` environment variables. **A bare invocation creates the annotated tag and pushes it**, which starts the publish with nothing between it and Docker Hub. Pass `--dry-run` to see the version and target commit without releasing.

### Tagging contract

| git tag | docker tags published | `latest` moves? |
| --- | --- | --- |
| `v0.5.0` | `0.5.0`, `latest` | yes |
| `v0.6.0-rc.1` | `0.6.0-rc.1` | no — prereleases are opt-in by name |
| `v0.4.10` (backport, `0.5.0` already published) | `0.4.10` | no — `latest` never rolls back |
| `v0.5.0` again (rerun / force-moved git tag) | none | no — the workflow fails: the tag already exists |
| `v2024-hotfix` (not semver) | none | no — the workflow fails before any image exists |

The invariants behind that table, each enforced by the workflow rather than by convention:

- **Semver docker tags are immutable.** The build job refuses to publish a version whose docker tag already exists in the registry, so a rerun after a successful publish (or a force-moved git tag) fails instead of silently re-pointing the tag. No mutable `{major}` / `{major}.{minor}` aliases are published — Rome Cloud resolves available versions by listing the exact semver tags, so aliases would only add dangling pointers.
- **`latest` always points at the highest published stable release.** The publish job compares the release against every stable semver tag already in the registry and only moves `latest` when the new version is the highest. Prereleases never move it. The metadata action's own `latest` behavior is disabled (`flavor: latest=false`) so this check is the single authority.
- **A `v*` tag must be strict semver** (`vMAJOR.MINOR.PATCH` with optional `-prerelease`, and `+buildmeta` is rejected because docker tags cannot contain `+`). The gate lives in the workflow's build-metadata step and is the single producer-side validation for the version that gets baked into the image.

### Baked build identity

The workflow freezes `ROME_VERSION` (tag with `v` stripped — always equal to the image's docker tag), `ROME_BUILD_SHA`, and `ROME_BUILD_TIME` into the image as env vars. The runtime reports them via `getBuildInfo()` → `/api/build-info`. `version` is `null` on non-release builds (local/source runs), and consumers degrade gracefully on null rather than guessing.

### GitHub release

After the image is published, the workflow's last job creates a GitHub release for the tag, titled `Rome vX.Y.Z`. [`scripts/docker/release-notes.mjs`](../scripts/docker/release-notes.mjs) writes its notes, and they hold:

- The image name and version, and the commit it was built from.
- The commits since the previous release, grouped as Breaking changes (a `!` after the type, or a `BREAKING CHANGE:` footer), New (`feat`), Fixes (`fix`, `perf`, `revert`) and Other changes (subjects that are not Conventional Commits). Every other type goes in a collapsed Internal changes list.
- A link to the full comparison.

The previous release is the highest stable version below this one on Docker Hub, so the changes of a tag whose build never shipped roll into the next release. A prerelease counts from the stable version before it.

A commit is listed only when it touches a file the image is built from. [`scripts/docker/runtime-inputs.mjs`](../scripts/docker/runtime-inputs.mjs) holds those rules, and [`prepare-runtime-workspace.mjs`](../scripts/docker/prepare-runtime-workspace.mjs) copies the build context by the same rules, so the notes and the image cannot disagree. The shipped docs are the one exception. The agent answers from them, but a commit whose only shipped files are docs is left out, since it changes no behavior.

A prerelease tag gets a prerelease. The release never takes the **Latest** badge from the package releases. The job fails when a release for the tag already exists. If it fails after the image went out, rerun that job alone.

### Rehearsing the pipeline

`.github/workflows/docker-publish-test.yml` publishes to `zoolsher/rome` with separate `TEST_DOCKERHUB_*` secrets on manual dispatch and twice-daily schedules. It exercises the multi-arch build and manifest publish without creating production release tags. It does not use the production weekday schedule, CI gate, or version allocation, and creates no GitHub release. It is a copy, not a shared workflow — when changing the release pipeline, update both or note the drift.

## Mac app

The Mac app ships in three steps:

1. Push a `desktop-vMAJOR.MINOR.PATCH` tag. [`.github/workflows/desktop-build.yml`](../.github/workflows/desktop-build.yml) builds, signs, and notarizes the app at that version, and keeps the DMG, ZIP, and `latest-mac.yml` as a run artifact. The tag must be plain semver and newer than every other `desktop-v*` tag. A tagged build that cannot be signed fails.
2. Test the build.
3. Run [`.github/workflows/desktop-publish-updates.yml`](../.github/workflows/desktop-publish-updates.yml) with the build's run ID and `qa_approved` checked. Its first job copies the artifact to the update feed the installed apps read, and never rolls the feed back. When the channel is `stable`, a second job then creates the GitHub release for the tag.

The GitHub release is titled `Rome for Mac X.Y.Z` and carries the DMG and a `SHA256SUMS` file for it. Its notes list the commits since the previous Mac app release that touch the packages the app is built from: `packages/desktop`, `packages/desktop-base-web`, `packages/rome-node-core`, and `packages/lib`. Keep that list in the workflow in step with the app's workspace dependencies. The release never takes the **Latest** badge from the package releases.

Only the release job writes to the repository, and it does not see the update feed's deploy secrets. It fails when a release for the tag already exists. If it fails after the feed went out, rerun that job alone.

## npm packages (via release-please)

Seven workspace packages are managed for npm publication via [release-please](https://github.com/googleapis/release-please):

- `@rome-os/app-runtime` (`packages/app-runtime-sdk/`)
- `@rome-os/app-web-sdk` (`packages/app-web-sdk/`)
- `@rome-os/ui` (`packages/ui/`) — the shared component kit
- `@rome-os/libs` (`packages/lib/`) — internal runtime primitives shared by Rome services
- `@rome-os/rome-web-components` (`packages/web-content/`) — internal web content components shared by Rome surfaces
- `@rome-os/node` (`packages/rome-node-cli/`) — the standalone device CLI
- `@rome-os/node-core` (`packages/rome-node-core/`) — the device library and shared caller daemon

The SDKs and `@rome-os/ui` are supported public packages. `@rome-os/libs` and
`@rome-os/rome-web-components` will be published so Rome and Rome Cloud can
share versioned implementations across repositories. They are not supported
app-author APIs.

Releases are driven by **Conventional Commits**, not by hand-authored changeset files. Every commit landing on `main` either contributes to the next release (if its type/path are in scope) or is invisible to the release flow.

## How the package scope is enforced

`release-please-config.json` names the releasable packages explicitly:

```json
"packages": {
  "packages/app-runtime-sdk": { "package-name": "@rome-os/app-runtime" },
  "packages/app-web-sdk":     { "package-name": "@rome-os/app-web-sdk" },
  "packages/ui":              { "package-name": "@rome-os/ui" },
  "packages/lib":             { "package-name": "@rome-os/libs" },
  "packages/web-content":     { "package-name": "@rome-os/rome-web-components" },
  "packages/rome-node-cli":       { "package-name": "@rome-os/node" },
  "packages/rome-node-core":      { "package-name": "@rome-os/node-core" }
}
```

Only commits that touch files **inside one of those paths** are attributed to that package's next release. A commit that only edits `packages/core/` or `rome_apps/foo/` is invisible to release-please — there is nothing to gate, no PR check to fail.

When adding a new releasable package: add a `packages/<dir>` entry to `release-please-config.json` and seed its current version in `.release-please-manifest.json`. Otherwise the new workspace is silently skipped — which is the safe default.

## Conventional Commits — what counts and what bumps

Commit messages drive both the changelog and the version bump. The release workflow respects squash-and-merge: the squash commit subject is the one that release-please reads, so PR titles must be Conventional too.

| Commit type    | Surfaces in CHANGELOG? | Pre-1.0 bump | Post-1.0 bump |
| -------------- | ---------------------- | ------------ | ------------- |
| `feat:`        | ✓ (Features)           | patch        | minor         |
| `fix:`         | ✓ (Bug Fixes)          | patch        | patch         |
| `feat!:` / `BREAKING CHANGE:` | ✓ (BREAKING) | minor        | major         |
| `perf:`, `refactor:`, `docs:` | optional     | patch / none | patch / none  |
| `chore:`, `ci:`, `test:`, `style:` | hidden  | none         | none          |

The pre-1.0 column reflects our config (`bump-minor-pre-major: true`, `bump-patch-for-minor-pre-major: true`). Once a package cuts `1.0.0`, drop those flags for that entry to get standard semver.

All seven packages are still under `0.x.y` today, so the practical rules are:

- Removed export, changed signature, behavior change consumers must adapt to → `feat!:` or include `BREAKING CHANGE:` in the body → minor bump.
- New API or backwards-compatible additive change → `feat:` → patch bump.
- Bugfix or internal change with observable impact → `fix:` → patch bump.
- Internal-only change consumers do not see → `chore:` / `refactor:` → no bump, no changelog line.

## Authoring a PR

1. Make your change. PR title must be a Conventional Commit (e.g. `feat(app-runtime): add IpcRpcTimeoutError`). Squash-and-merge uses this as the merge commit.
2. If the change touches any path configured in `release-please-config.json`, pick the right type so the version bump reflects observable impact. Use `feat!:` (or `BREAKING CHANGE:` in the body) for breakage even pre-1.0 — it is still the loudest signal in the changelog.
3. If the change does not touch a releasable package's path, no special handling needed — release-please ignores it.

The title format is enforced: CI's `lint` job runs `scripts/check-pr-title.sh` on every PR open/edit, so a non-conventional title fails a check instead of landing on `main` as a commit release-please cannot read. It validates the shape (`<type>[(<scope>)][!]: <subject>`, lower-case type and scope) against the standard type set — it does not judge whether you picked the *right* type for the change, or whether the subject reads well.

The subject is optional on a normal title (`chore:` passes), but **required whenever `!` is present**. release-please's parser reports a bare `feat!:` as non-breaking while reporting `feat!: subject` as breaking, so a subject-less breaking title would quietly downgrade a minor bump to a patch. Run it locally before pushing:

```bash
scripts/check-pr-title.sh "feat(app-runtime): add IpcRpcTimeoutError"
```

There is no PR-time "did you add a changeset?" check. The merge commit is the source of truth.

## What happens after merge

1. Your PR's squash commit lands on `main`.
2. The `Release` workflow runs release-please. If there are any unreleased Conventional commits attributed to a releasable package, it opens (or updates) a single release PR titled `chore: release …` that bumps `version` in each affected `package.json` and appends to that package's `CHANGELOG.md`. Multiple commits accumulate into the same PR until it merges.
3. Merging the release PR triggers the workflow again. release-please now creates a GitHub release + git tag for each package whose version moved and emits `paths_released`. The follow-up `publish` job matrixes over those paths, runs `pnpm build` in each, and pushes the tarball to npm.

The publish step is the merge of the release PR, not your original PR — so contributors do not have to worry about "every small fix becomes its own release". Multiple commits ship together.

### Every published package declares `repository`

This repository is public and publishes through an npm Trusted Publisher, so npm
attaches a provenance attestation to each upload on its own — `sdk-publish.yml`
never passes `--provenance`. npm then compares the packed manifest against that
attestation and rejects the upload with HTTP 422 when `repository.url` does not
resolve to `https://github.com/rome-os/rome`:

```
[E422] 422 Unprocessable Entity - PUT https://registry.npmjs.org/@rome-os%2fui
Error verifying sigstore provenance bundle: Failed to validate repository
information: package.json: "repository.url" is "", expected to match
"https://github.com/rome-os/rome" from provenance
```

So every entry in `release-please-config.json` also carries `repository` in its
`package.json`, with `directory` set to its own workspace path. A new releasable
package without it builds, packs, and then fails at the upload — after
release-please has already cut the tag and the GitHub release, which is the
expensive place to find out.

## Manual npm publish retry

Use `.github/workflows/release.yml` as the single npm publish entrypoint, even
for manual retries or hotfix publishes. In Actions, run `Release` manually and
choose `all` or one package path. `all` expands to every package in
`release-please-config.json`. Each one also stays individually selectable, for a
dry run or a single-package retry. The manual path calls the same reusable
`sdk-publish.yml` implementation as automatic release publishes, but keeps the
OIDC caller identity anchored on `release.yml`.

The `all` list in `sdk-publish.yml` is maintained by hand, so it and
`release-please-config.json` have to stay in step. A package in `all` without a
Trusted Publisher fails every `all` dispatch, not just its own. A package left
out of `all` is reachable only by selecting it by name.

The npm Trusted Publisher for every published package must be configured to this
repository's `.github/workflows/release.yml`. Configure a new package's
publisher before merging its first generated release PR, and before adding it
to `all`. npm only allows one trusted publisher per package, and
reusable workflow calls are authorized against the caller workflow, so
`sdk-publish.yml` is intentionally not directly dispatchable.

## Where to look

- `release-please-config.json` — Per-package release config (release-type, bump rules, plugins).
- `.release-please-manifest.json` — Current version per package path. release-please updates this in the release PR. Never edit by hand.
- `.github/workflows/release.yml` — Single publish entrypoint: push events run `release-please` and automatic npm publish. Manual dispatches retry/publish selected packages under the same npm Trusted Publisher identity.
- `.github/workflows/sdk-publish.yml` — Reusable implementation called by `release.yml`. Do not run it directly.
- `.github/workflows/desktop-build.yml` and `.github/workflows/desktop-publish-updates.yml` — Mac app build, update feed, and GitHub release. See [Mac app](#mac-app).
- `scripts/check-publish-targets.test.mjs` (`pnpm test:release:targets`, part of `test:unit:rest`) — Holds the three package lists together: the `all` dispatch target, the dispatch menu, and `release-please-config.json`. It also asserts every released package declares `repository`.
- The `lint` job in `.github/workflows/ci.yml` + `scripts/check-pr-title.sh` — PR-time gate on the Conventional Commit title that becomes the squash commit. It is the job's first step, ahead of the toolchain install, so a bad title reports in seconds. Read the note below before making it a required check.

### Before requiring any check on `main`

Workflows do not start automatically for pull requests opened by the built-in `GITHUB_TOKEN`. Runs on release-please's own PR are created in the `action_required` state and wait for a maintainer to approve them — visible on the release branch today, where `CI` runs alternate between `action_required` and `success` depending on whether someone clicked through. Nothing is permanently unsatisfiable, but every required context becomes a manual approval step on every release PR, and `main` sets `enforce_admins: true`, so there is no admin bypass when someone forgets.

To restore automatic runs, pass a GitHub App installation token (or a PAT) as `token:` to `googleapis/release-please-action` in `release.yml` — PRs it opens then trigger workflows like any other. Do that first if you do not want the approval step, then add `lint` — and whatever else should gate merges — to the required status checks.
- `packages/<pkg>/CHANGELOG.md` — Generated and appended-to by release-please. Do not edit by hand. Release-please reconciles entries from commits.
