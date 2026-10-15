---
name: respond-to-review
description: Address pull request review feedback, make focused changes, and summarize the outcome in one short reply. Use when the user asks to handle, address, or respond to review comments. Not for requesting or performing a code review.
---

# Respond to review feedback

The goal is to get the PR merged as the change it set out to be, with every reviewer concern settled. Two things defeat that: the PR grows with each review round and drifts from its scope, or findings stay open and the next round raises them again.

- **Stay on scope.** Fix real defects this PR introduced, each proven by a test. An existing defect that makes this PR wrong or unsafe to merge — the change depends on it, or makes it reachable — gets its own PR, and this PR waits on it with a "Depends on" line in its description. Open that PR from a new session when the environment allows, otherwise do it here. Everything else stays out of this PR; file a bug issue for a real defect unless one already exists.
- **Leave nothing open.** Every finding ends fixed here, fixed in a blocking PR, filed as an issue, or declined with a reason.
- **Close the loop in one short reply.** Say what changed, what did not, and why, so the reviewer can approve without asking again.

When the issue the PR closes looks wrong, ask the user. Never edit the issue.
