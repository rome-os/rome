---
name: babysit-pr
description: Watch a PR for review feedback and answer each new round with the respond-to-review skill, on a self-paced timer, until the PR is approved or a round raises no new points. Use when the user says "babysit this PR".
argument-hint: [pr]
disable-model-invocation: true
---

# Babysit a PR

Watch $ARGUMENTS — the PR for the current branch when the argument is empty — and run [respond-to-review](../respond-to-review/SKILL.md) on every new round of review feedback, until the PR is approved or a round raises no new points.

The environment decides the mechanism: a watcher that wakes the session when a review lands, or a poll every five minutes. Each tick, read the reviews and comments posted since the last tick and run respond-to-review on the new findings, then end the turn with the next tick scheduled. Once the PR is approved or a round raises no new points, schedule nothing and report the outcome.
