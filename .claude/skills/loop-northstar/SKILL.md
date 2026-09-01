---
name: loop-northstar
description: Hold an interactive session to create or revise an ideal-state doc, or to slice it into approved repository milestones.
disable-model-invocation: true
---

# Loop: north star

Goal end-state: the ideal state of the target area is written down and agreed — as a doc PR, and when the session slices it, as approved repository milestones.

This is the interactive half of the reconciliation loop. The autonomous half (`loop-reconcile`) computes the gap between these artifacts and the codebase and files work issues. This session files no work issues.

## The ideal-state doc

The doc lives in `docs/northstars/`, one file per area, named for the area it describes. It describes the ideal present — what should be true. Never how to get there, and never what used to be. Prose follows [WRITING.md](../../../docs/authoring/WRITING.md).

The body takes whatever form fits the subject — contract tables, flow descriptions, diagrams, examples — with one required section: **Statements**, a bullet list of checkable claims. Only the Statements section has authority. `loop-reconcile` computes the gap against it, and everything else is illustration.

Admission rules for every statement:

- Declarative present tense. No "currently", no "we will", no "migrate from", no milestone names.
- Checkable: an agent can verify compliance by reading the code.
- Open: more than one implementation can satisfy it. The test: the statement stands without naming a file, function, or type. A statement only one implementation satisfies is code transcribed into prose.
- A statement asserting that something is answered one way, or once, names the question it answers. Compliance turns on which reads count as the same question, so a uniqueness claim without its question cannot be checked.

Content that never enters the doc:

- Milestones. They go to the repository's milestone list and die there.
- Rationale. It goes to [an ADR](../../../docs/authoring/adrs.md).
- Migration policy. It lives in `loop-reconcile`.

## Milestones

A milestone is an intermediate ideal state. Its description is a Statements list — typically a subset or a weakened version of the north star's statements — plus optional notes. The same admission rules apply: what, never how.

- Slice the end state into pillars or layers. Pillars are independent and build in any order. Layers stack and build bottom up.
- A milestone must describe a state worth pausing at indefinitely. If pausing there leaves the codebase incoherent, the slice is wrong.
- Milestones are born approved. Consensus happens in this session, and the record lands as repository milestones. No proposed state exists.
- A milestone that falls behind a revised doc gets fixed here too: `loop-reconcile` reports the drift and stops, and the next session revises the milestone.
- A session that revises a doc also walks the open milestones and updates any statement the revision changed or removed, while the human is present to confirm.

## Flow

1. Orient. Read the existing doc if there is one, the repository's open milestones and `loop-reconcile` issues, and the code the doc covers.
2. Discuss to consensus. Draft in chat and iterate with the user. Push back on any statement that fails an admission rule.
3. Name each statement's decider. For every statement the session lands, new and existing, name the code a reader opens to decide compliance. A statement whose decider you cannot name is not checkable, and it does not land. This is the step that catches a statement describing a question the code does not ask.
4. Check consistency. Walk the full Statements list — new and existing statements together — and surface any two that cannot both hold. A revision session checks against the whole doc, not only the edited part.
5. Land the artifacts, only after the user's go-ahead in chat:
   1. The doc: open a branch and a PR. The user merges.
   2. The milestones: create each on GitHub with `gh api repos/{owner}/{repo}/milestones -f title=... -f description=...` — the title names the slice, the description holds its Statements list. Create layers in build order.

Nothing lands before the go-ahead.
