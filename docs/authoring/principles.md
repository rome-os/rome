# Principles Entries

**Principles** — a curation of disciplines for design and code — live in `principles/`. The family is load-bearing for agentic development. This doc defines the entry format, admission bar, and exit rules. Harvesting fills this mold — do not invent structure per entry. The sibling family, concepts, has its own guideline in [concepts.md](concepts.md).

## Format

One entry per principle. The shape matches feedback memories (principle / Why / How to apply), so harvesting from them is mechanical:

- **Principle** — one imperative sentence.
- **Why** — the reasoning, anchored in the decision it changed.
- **How to apply** — what to check at decision time. Concrete enough to run against a diff.
- **Violation** — one concrete example of getting it wrong. A real incident beats a hypothetical.

## Admission

A principle earns an entry when both hold:

1. It has changed a real decision at least once — the entry names that decision.
2. A competent person could plausibly get it wrong without the entry.

A principle everyone already follows fails the bar: it changes no decision and pays context load for nothing. Reject it.

## Exclusions

The [exclusions for concepts entries](concepts.md#exclusions) are banned here too.

## Eviction

The admission bar gates exit as well as entry: an entry that stops clearing it is removed, not kept for safety. An entry dies when its principle has become the default — no competent contributor would get it wrong anymore — or when the decision it guards cannot arise.

Trimming is part of every pass: any change that adds or edits entries also states what it checked for removal. "Nothing qualifies" is a valid finding. Not checking is not.

## Intake

When a review comment or correction recurs, it must exit through one of two doors: it becomes an entry (here if the miss was about judgment, in [concepts](concepts.md) if it was about what a term means), or it is consciously rejected with a stated reason — it fails an admission bar, or it is implementation detail that belongs in code review. Silent recurrence is the failure mode this rule prevents. A correction made three times with no entry and no rejection means these docs are dead.
