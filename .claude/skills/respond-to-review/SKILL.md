---
name: respond-to-review
description: Address pull request review feedback, make focused changes, and summarize the outcome in one short reply. Use when the user asks to handle, address, or respond to review comments. Not for requesting or performing a code review.
---

# Respond to review feedback

Goal end-state: every finding on the PR has exactly one of four answers — a minimal fix with a test, a corrected claim in the PR description, a follow-up issue, or a written decline. The PR's diff grows as little as possible.

Classification precedes code. Never start implementing a finding before classifying it.

## Phase 1 — Gather and dedupe

1. Pull every review body and inline comment on the PR. Drop reviews marked "This review has been superseded."
2. Merge duplicate findings — same file, same defect — into one item for classification.
3. Discard the bots' severity labels and verdicts. Phase 2 re-derives priority.

## Phase 2 — Classify every finding

Run each finding through these tests in order. The first test that matches decides the bucket.

### Test 1 — the bot hedged

If the bot itself presents the finding as optional or non-blocking — "no action required", "consider", "worth noting": **decline**.

### Test 2 — the PR already disclosed it

If the finding restates a "Not in this PR" item, a stated tradeoff, or a documented transitional state: **decline**, pointing at the section that covers it.

### Test 3 — no caller can reach it

Ask what concrete caller, with what concrete input, hits the defect on `main` plus this diff. If the answer needs a future adapter, a third-party implementation, an input no caller produces, or a scale nothing is wired to reach: **decline**, stating what would have to exist first. If the concern matters later, record it as one sentence in the interface contract or as a follow-up issue.

### Test 4 — the defect predates the diff

If the defect exists on `main` without this diff: **follow-up issue**, linked from the reply.

Exception: if the PR's own claims depend on the old code being correct — for example, a claim of parity with it — fix the defect in this PR.

### Test 5 — code or claim

The finding is real, reachable, and introduced here. If it does not contradict a claim in the PR description, **fix the code**. If it does, trace the claim to the issue the PR closes:

- The issue demands the claim: **fix the code**.
- The claim is author-added, or there is no linked issue: fix the code or shrink the claim, whichever leaves the smaller diff.
- The issue demands the claim and the requirement looks wrong: stop and ask the user. Never edit the issue.

Shrinking a claim means editing the PR description and stating the change in the reply.

## Phase 3 — Fix what earned a fix

For each finding in the **fix** bucket:

1. Reproduce the finding as a failing test against real callers. If no such test can be written, return the finding to Phase 2 as a decline.
2. Make the smallest change that passes. Prefer deleting or narrowing over adding. A defensive branch requires both a test that fails without it and a caller that can reach it.
3. Check that reverting the fix fails exactly the new test.
4. When the accumulated response diff nears a third of the PR's own diff, stop. Shrink a claim or move the rest to a follow-up issue.

## Phase 4 — Write one short summary reply

Post exactly one short reply in the PR conversation thread after handling the review. Do not reply to individual comments or inline threads. Do not post cross-links or acknowledgments on each finding.

Summarize the fixes and validation, any corrected PR claims, and follow-up issues with links. Group declined findings by reason and mention only what the reviewer needs to understand the outcome. Keep the reply to a short paragraph or a few brief bullets. Do not enumerate findings one by one.

A "Not in this PR" line or a stated tradeoff in the PR description supports declining a finding. Write those sections before requesting review.
