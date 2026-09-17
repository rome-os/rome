---
name: babysit-pr
description: Watch a PR on a self-paced timer and keep it mergeable — answer each new round of review feedback with the respond-to-review skill, fix failing CI, and resolve merge conflicts with main — until the PR is approved or reviewed clean, CI is green, and it merges cleanly. Use when the user says "babysit this PR".
argument-hint: [pr]
disable-model-invocation: true
---

# Babysit a PR

Watch $ARGUMENTS — the PR for the current branch when the argument is empty — and keep it ready to merge. The PR is done when all three hold:

- **Review:** the PR is approved, or the latest round raised no new points.
- **CI:** every check passed, or fails the same way on the base branch.
- **Mergeability:** the branch merges into the base branch without conflicts.

Babysitting never merges the PR. Merging stays with the user.

## The loop

The environment decides the mechanism: a watcher that wakes the session when a review or check lands, or a poll every five minutes. Each tick, check the PR in the order below, push at most one commit, then end the turn with the next tick scheduled.

1. **Conflicts first.** Read `mergeable` from `gh pr view --json mergeable,mergeStateStatus`. On `CONFLICTING`, follow [Merge conflicts](#merge-conflicts). A conflicted branch runs no meaningful CI, so skip the other steps this tick.
2. **Review.** Read the reviews and comments posted since the last tick and run [respond-to-review](../respond-to-review/SKILL.md) on the new findings.
3. **CI.** Read `gh pr checks`. Wait on pending checks. On a failed check, follow [CI failures](#ci-failures).

Before pushing, run `pnpm typecheck` and the unit tests covering the touched code. Batch the tick's conflict, review, and CI fixes into one push, so each push starts one CI run.

Once all three conditions hold, schedule nothing and report the outcome. When a step needs the user, schedule nothing, report what blocks the PR, and name the decision needed.

## Merge conflicts

1. `git fetch origin <base>` and `git merge origin/<base>` into the PR branch. Merge rather than rebase: the PR squash-merges, so a merge commit costs nothing and needs no force-push.
2. Resolve each conflict by keeping the intent of both sides. Read the base-branch commit that touched the hunk (`git log origin/<base> -- <file>`) before choosing.
3. When the two sides make incompatible decisions — the base branch deleted or redesigned what the PR builds on — abort the merge and ask the user.
4. Regenerate generated files, such as `pnpm-lock.yaml` with `pnpm install`, instead of hand-merging them.
5. Run `pnpm typecheck` and the affected tests, then commit the merge and push.

## CI failures

1. Find the failing job and read its log: `gh run view <run-id> --log-failed`.
2. Decide whether the diff caused it. Check whether the same job fails on the base branch's latest run (`gh run list --branch <base> --workflow <workflow>`).
   - **The diff caused it:** reproduce the failure locally, make the smallest fix, and push.
   - **The base branch fails the same way:** the PR did not cause it. Leave it, and name the failing job in the final report.
   - **Infrastructure or a flaky test** — a timeout, a network error, a test that passes locally and on the base branch: rerun the failed jobs once with `gh run rerun <run-id> --failed`. On a second failure, treat it as caused by the diff.
3. Fix only what the failure demands. A CI fix follows the same diff discipline as a review fix in respond-to-review.
4. After two fix attempts on the same failure, stop and ask the user.
