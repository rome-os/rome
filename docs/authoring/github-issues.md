# GitHub Issues

A **GitHub issue** is one tracked unit of work on the repo's issue tracker. This file holds the rules every issue shares. Each issue type has its own rulebook, and this file wins where a rule there conflicts with it. Prose rules come from [WRITING.md](WRITING.md).

## Issue types

Every issue is one of three types. The type names the next action the issue asks for, not the kind of change.

- **[bug report](github-issues-bug-report.md)** — a defect in behavior the system already ships. The next action is an investigation. An incident write-up files as a bug report.
- **[feature request](github-issues-feature-request.md)** — a pain, gap, or missing capability where the change is undecided. The next action is a design conversation.
- **[task spec](github-issues-task-spec.md)** — a scoped change for a person or agent to implement. The next action is implementation.

Two questions decide the type. Does the system break its own intended behavior? File a bug report. Is the change already decided and scoped? File a task spec. Otherwise file a feature request — a feature idea and a pain point file the same way.

## Title

A title reads `<area>: <statement>`. The area is a lower-case component or surface name, such as `relay`, `connector`, `docs`, `web`. An issue in a planned set reads the same way — a step code such as `[D1]` never leads a title, because the ordering lives in the blocked-by edges.

Each type's rulebook fixes the mood of the statement.

## Situation

Every issue body opens with a **Situation** section: what is going on, in plain words, before any section that names code.

Situation uses the nouns and verbs the project already agreed on. Those live in [`concepts/`](../concepts/index.md), and a term links to its entry on first use.

> Prefer: "Rome answers one question in two places: which addresses belong to the same person?"
> Over: "The people directory and the timeline each run their own account fold."

When the situation needs a term concepts does not carry, pick one and define it in a **Terminology** section directly after Situation. One line per term, and that term everywhere below. A term used on more than one surface and carrying a contract [earns a concepts entry](concepts.md#admission) instead.

Situation names no file, symbol, or line number.

> Prefer: "the message history page gathers a person's addresses on its own, and gathers them less thoroughly than the contacts list does."
> Over: "`timeline-sources.ts:88-140` duplicates `foldAccounts` and drops the `book.resolve` branch."

## Labels

Every issue carries the label of its type: `bug`, `feature-request`, or `task`. The other labels an issue carries are fixed by its type's rulebook.
