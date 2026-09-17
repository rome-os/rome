---
name: babysit-pr
description: Watch a PR on a self-paced timer and keep it mergeable — answer review feedback with the respond-to-review skill, fix failing CI, and resolve merge conflicts with the base branch — until it is reviewed clean, green, and conflict-free. Use when the user says "babysit this PR".
argument-hint: [pr]
disable-model-invocation: true
---

# Babysit a PR

Watch $ARGUMENTS — the PR for the current branch when the argument is empty — and keep it ready to merge. The PR is done when the latest review round approved it or raised no new points, no check on the head commit failed except ones the base branch fails the same way, and GitHub reports it mergeable.

Babysitting never merges the PR. Merging stays with the user.

## Responsibilities

Work on the PR's own branch, checked out from the PR, and address every `gh` command to that PR.

The environment decides the mechanism: a watcher that wakes the session when a review or check lands, or a poll every five minutes. Each tick, handle in this order:

- **Merge conflicts.** Merge the base branch into the PR branch — never rebase, since the PR squash-merges — and resolve each conflict by keeping the intent of both sides. Regenerate generated files such as the lockfile rather than hand-merging them. When the two sides made incompatible decisions, abort and ask the user. A conflict merge goes out as its own push, with the merge commit message describing each resolution so the user can audit it, and the tick ends there; review and CI work waits for the next tick, which sees fresh checks. GitHub computes mergeability asynchronously, so an `UNKNOWN` answer means read it again next tick, and only `MERGEABLE` counts as clean.
- **Review feedback.** Run [respond-to-review](../respond-to-review/SKILL.md) on every finding not yet answered.
- **CI failures.** Read the failing job's log and decide whether the diff caused it. If the base branch's latest run fails the same way, leave it and name it in the final report. If it looks like infrastructure or a flake, rerun the failed jobs once; a rerun is not a fix attempt, and a second failure counts as caused by the diff. Otherwise reproduce it locally and make the smallest fix, under the same diff discipline as a review fix. After two attempts on one failure, ask the user.

Before pushing, run the repo's verification loop inside the devShell. Push a tick's review and CI fixes together, so each push starts one CI run. The PR itself keeps the counts: a push is a babysitting commit on the branch, and a finding is answered once a reply covers it. A tick that pushed always schedules another, and a commit with no checks reported yet has pending CI.

Once the done conditions hold, schedule nothing and report the outcome. When a step needs the user, after five pushes in one session, or after an hour of ticks with nothing to do, schedule nothing, report what blocks the PR, and name the decision needed.
