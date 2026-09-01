# Concepts Entries

**Concepts** — a unified set of terms with their contracts — live in [`concepts/`](../concepts/index.md). The family is load-bearing for agentic development. This doc defines the entry format, admission bar, and exit rules. Harvesting fills this mold — do not invent structure per entry. The sibling family, principles, has its own guideline in [principles.md](principles.md).

## Format

One entry per term, as a section in the relevant `concepts/` file:

- **Term** — the section heading. One concept, one name: this is the canonical name. Words other surfaces use for the same concept are listed here as deprecated aliases, and new code and docs use the canonical name. Other docs link here instead of re-defining ([Linking](WRITING.md#linking)).
- **Definition** — one or two sentences, statable without reference to any file, type, or function.
- **Contracts** — the invariants the concept carries: what a contributor can rely on, and what a diff must not break. Entries are deliberately concepts *plus their contracts*, not a pure glossary.
- **Not to be confused with** — near-miss terms, each with the one line that separates them.

## Admission

A term earns an entry when all hold:

1. It is used on more than one surface (code, docs, UI copy, agent prompts, conversation).
2. It carries a contract a diff could silently violate, **or** two people/agents have plausibly meant different things by it.
3. It is separable from every existing entry in one line — the near-miss line is the test. If that line cannot be written, it is the same concept: merge into the existing entry and record the loser as an alias, not an entry.

## Exclusions

Content banned from entries, regardless of the admission bar ([principles entries](principles.md#exclusions) ban the same list):

- **Implementation pointers** — file paths, function/type names, code mechanisms. Contracts name behavior. The mechanism enforcing it [belongs in code review](../CLAUDE.md#traps), not here.
- **Environment caches** — restatements of what a lookup already answers: `package.json` scripts, config files, `--help` output, directory layout. The lookup cannot go stale. The restatement can. Link or omit.
<!-- vale Rome.History = NO -->
- **History** — prior states and change narration ("previously", "no longer", "renamed from"). Entries state what is true now. Git history owns the past.
<!-- vale Rome.History = YES -->
- **Process steps** — how-to sequences and runbooks. Those are skills in [`.claude/skills/`](../../.claude/skills/), loaded when they fire. These docs carry only what must hold on every diff.

## Eviction

The admission bar gates exit as well as entry: an entry that stops clearing it is removed, not kept for safety. An entry dies when no surface still uses the term, or when nothing enforces its contract and its ambiguity is gone. A concept that stops being separable from a neighbor merges into it and survives only as an alias line.

Trimming is part of every pass: any change that adds or edits entries also states what it checked for removal. "Nothing qualifies" is a valid finding. Not checking is not.

## Intake

When a review comment or correction recurs, it must exit through one of two doors: it becomes an entry (here if the miss was about what a term means, in [principles](principles.md) if it was about judgment), or it is consciously rejected with a stated reason — it fails an admission bar, or it is implementation detail that belongs in code review. Silent recurrence is the failure mode this rule prevents. A correction made three times with no entry and no rejection means these docs are dead.
