---
name: babysit-pr
description: Watch a PR on a self-paced timer and keep it mergeable — answer each new round of review feedback with the respond-to-review skill, fix failing CI, and resolve merge conflicts with the base branch — until the PR is approved or reviewed clean, CI is green, and it merges cleanly. Use when the user says "babysit this PR".
argument-hint: [pr]
disable-model-invocation: true
---

# Babysit a PR

Watch $ARGUMENTS — the PR for the current branch when the argument is empty — and keep it ready to merge. The PR is done when all three hold for its current head commit:

- **Review:** the PR is approved, or the latest round raised no new points.
- **CI:** every check passed, or fails the same way on the base branch.
- **Mergeability:** `mergeable` is `MERGEABLE`.

Babysitting never merges the PR. Merging stays with the user.

## Setup

Resolve the PR once with `gh pr view <pr> --json number,headRefName,baseRefName`. `<head>` and `<base>` below are those branch names. Run `gh pr checkout <pr>`, and pass the PR number to every `gh pr` command in the loop.

## The loop

The environment decides the mechanism: a watcher that wakes the session when a review or check lands, or a poll every five minutes. Each tick, `git pull` the PR branch, check the PR in the order below, push at most once, then end the turn with the next tick scheduled.

1. **Conflicts first.** Read `gh pr view <pr> --json mergeable`. On `CONFLICTING`, follow [Merge conflicts](#merge-conflicts), push the merge on its own, and skip the other steps this tick. On `UNKNOWN`, GitHub is still computing it: continue with the other steps and read it again next tick.
2. **Review.** Read the reviews and comments posted since the last tick and run [respond-to-review](../respond-to-review/SKILL.md) on the new findings.
3. **CI.** Read `gh pr checks <pr>`. Wait on pending checks. On a failed check, follow [CI failures](#ci-failures).

Before pushing, run `pnpm typecheck` and `pnpm test:unit` inside `nix develop`. Push the tick's review and CI fixes together, so each push starts one CI run.

A tick that pushed always schedules another tick. The done conditions count only checks and reviews on the current head commit, and a commit with no checks reported yet has pending CI.

Once all three conditions hold, schedule nothing and report the outcome. When a step needs the user, or after five pushes in one babysitting session, schedule nothing, report what blocks the PR, and name the decision needed.

## Merge conflicts

1. `git fetch origin <base>` and `git merge origin/<base>` into the PR branch. Merge rather than rebase: the PR squash-merges, so a merge commit costs nothing and needs no force-push.
2. Resolve each conflict by keeping the intent of both sides. Read the base-branch commit that touched the hunk (`git log origin/<base> -- <file>`) before choosing.
3. When the two sides make incompatible decisions — the base branch deleted or redesigned what the PR builds on — abort the merge and ask the user.
4. Regenerate generated files instead of hand-merging them — `pnpm-lock.yaml` with `pnpm install` inside `nix develop`.
5. Run `pnpm typecheck` and `pnpm test:unit`, then commit the merge and push.

## CI failures

1. Find the failing job and read its log. The run id is in the check's link, and `<workflow>` is its workflow (`gh pr checks <pr> --json name,bucket,link,workflow`); read the log with `gh run view <run-id> --log-failed`.
2. Decide whether the diff caused it. Check whether the same job fails on the base branch's latest run (`gh run list --branch <base> --workflow <workflow>`).
   - **The diff caused it:** reproduce the failure locally, make the smallest fix, and push.
   - **The base branch fails the same way:** the PR did not cause it. Leave it, and name the failing job in the final report.
   - **Infrastructure or a flaky test** — a timeout, a network error, a test that passes locally and on the base branch: rerun the failed jobs once with `gh run rerun <run-id> --failed`. On a second failure, treat it as caused by the diff.
3. Fix only what the failure demands. A CI fix follows the same diff discipline as a review fix in respond-to-review.
4. After two fix attempts on the same failure, stop and ask the user.
