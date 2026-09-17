---
name: babysit-pr
description: Watch a PR on a self-paced timer and keep it mergeable — answer review feedback with the respond-to-review skill, fix failing CI, and resolve merge conflicts — until it is reviewed clean, green, and conflict-free. Use when the user says "babysit this PR".
argument-hint: [pr]
disable-model-invocation: true
---

# Babysit a PR

Watch $ARGUMENTS — the PR for the current branch when the argument is empty — and keep it ready to merge: run [respond-to-review](../respond-to-review/SKILL.md) on every new round of review feedback, fix CI failures the diff caused, and resolve merge conflicts with the base branch. Merging the PR itself stays with the user.

The environment decides the mechanism: a watcher that wakes the session when a review or check lands, or a poll every five minutes. Each tick, handle whatever is new, then end the turn with the next tick scheduled. Once the PR is approved or a round raises no new points, CI is green, and the branch merges cleanly, schedule nothing and report the outcome. When something needs the user's decision, stop and ask.
