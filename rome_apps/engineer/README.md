# Engineer

An engineering manager that works your GitHub backlog overnight — and never
touches the merge button.

## What it does

Tell Engineer what you want built and walk away. It files the task as a labeled
GitHub issue, then every half hour it looks at the repository and moves each
task one step: starting a coding session, pushing it through failing checks,
answering the review bots, and labeling the pull request ready when everything
is green. By morning each task is either a pull request waiting for you or an
issue that says plainly why it is stuck.

## Features

- **Ask in chat** — start a chat with Engineer from the agent picker (type `@`
  in the composer and pick Engineer), then describe the work. It searches for a
  matching open issue first, files one if there is none, and replies with the
  link. It reads its configuration back from the recurring check-in it
  registered, so a brand-new chat already knows the repository and you never
  name it twice.
- **A pull request per task** — a child coding session does all the writing on
  its own `engineer/issue-<n>-…` branch and opens a pull request that closes the
  issue.
- **Reviews answered** — failing checks, merge conflicts, and unanswered review
  comments are handed back to the same session with the exact text to fix.
- **Everything is on GitHub** — issues, labels, and comments are the whole
  record, so you can read what happened per task without opening Rome.
- **Bounded** — one new task started per pass, at most three sessions running at
  once, at most three retries per issue, and any session still going after three
  hours is stopped. An unattended week stays cheap, and nothing loops forever.
- **You merge** — `engineer:ready` is the only thing it puts on a finished pull
  request. It never merges.

## When to use it

When you have a queue of small, well-described changes and you would rather
review them than write them: dependency bumps, test coverage, small fixes, copy
changes. Connect GitHub in /settings, then say "work on owner/name" to point it
at a repository.

Every setting is optional and has a default: the task label (`engineer`), the
clone path, how often it checks in (30 minutes), when the daily report arrives
(08:00), how many tasks it starts per pass (1), how many sessions run at once
(3), how many retries an issue gets (3), how long a session may run before it is
stopped (3 hours), and how many issues one pass reads (20). Ask for a different
value in the same sentence that names the repository.
