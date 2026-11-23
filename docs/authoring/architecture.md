# Architecture Docs

An **architecture doc** covers one surface: it names the surface's components, the flow between them, and the [structural contracts](../AGENTS.md#traps) a diff must not break. The family lives in [`architecture/`](../architecture/index.md). This file is the rulebook for that family.

Tier tags and the bar a rulebook clears come from [authoring.md](authoring.md). Prose rules come from [WRITING.md](WRITING.md). This file adds only what the architecture family needs on top. The misses that earned it: the index omits two docs that exist in the directory, and five docs cite file paths that structural contracts ban.

## Format

- **Name** — kebab-case, named for the surface (`channels.md`, `build.md`). `[mech]`
- **Scope** — the first paragraph states which surface the doc owns and the question it answers. `[llm]`

  > Prefer: "How the channel adapters identify themselves to their underlying platforms, and the rules that keep their credentials separated."
  > Over: opening on the first mechanism detail with no statement of which surface the doc owns.

- **Invariants** — every doc carries at least one list under an **Invariants** heading. The invariants are the payload. Every other sentence exists to make them statable. `index.md` is exempt. `[mech]`
- **Index line** — `index.md` lists every doc in the directory with one line that separates it from every sibling. `[mech]`
- **Size** — a doc stays under 1,000 words. When it passes that, trim it or split the surface. The cap is a ceiling, not a target: no minimum exists, and a doc that states three invariants in 150 words is complete. `[mech]`

Entity definitions live in [`concepts/`](concepts.md). Rationale lives in [ADRs](adrs.md). Per-change design lives in [PR descriptions](prs.md). Link there instead of restating ([Linking](WRITING.md#linking)).

## Admission

Two tests gate every sentence:

1. **The local-correctness test.** A sentence must state intent that a violating diff does not reveal: the diff compiles, its tests pass, and it reads correctly in isolation — only the stated rule rejects it. If the code, a type, or a test already exposes the violation, the sentence restates the implementation. The check: name the concrete drift, the plausible diff the sentence exists to reject. If no drift can be named, the sentence does not enter. Doubt rejects. `[llm]`

   > Prefer: "The installer never reads the lockfile."
   > Over: "The install call writes the lockfile after materializing the bundle."

2. **The refactor test.** If a refactor that preserves behavior could make the sentence false, the sentence states mechanism, not contract. It does not enter. `[llm]`

   > Prefer: "The routing layer cannot observe which external channel a message originated from."
   > Over: "The message hook strips channel metadata before dispatch."

Corollaries at section level:

- A component is named only when an invariant references it. `[llm]`

  > Prefer: naming the edge probe because the fail-closed access invariant constrains it.
  > Over: a roster of every module on the surface, most never referenced by an invariant.

- One flow per doc. The canonical traversal appears once. A variant is stated as a delta from that flow, never as a second walkthrough. `[llm]`

  > Prefer: "The visitor path differs in one step: the edge probe rejects unverified sessions."
  > Over: a second full walkthrough that repeats the guardian path with one step changed.

- The doc describes the system as built. Planned behavior goes to an ADR or an issue. `[llm]`

  > Prefer: "The daemon rejects uninstalling a first-party app."
  > Over: "The daemon will validate per-app quotas once the quota system lands."

The family admits only constraints *between* components of one surface. A contract a caller can observe from outside the surface belongs on the concept ([concepts](concepts.md)) — the architecture doc links to it and never restates it. The check: before a contract enters here, search the concepts family for an existing owner. Finding one turns the sentence into a link. Finding none, for an observable contract, creates the concept entry, not an architecture sentence. `[llm]`

> Prefer: "install is a completion barrier" as a lifecycle contract in the concepts family, linked from the architecture doc.
> Over: the same contract stated in both files.

A new doc enters the family only when no existing doc owns the surface. The index line is the test: if a line separating the new doc from every sibling cannot be written, the content belongs in the sibling. `[llm]`

> Prefer: folding artifact-signing contracts into `app-artifact.md`.
> Over: a new `artifact-signing.md` whose index line restates `app-artifact.md`'s.

## Exclusions

Content the admission tests already reject, named so tooling can catch it:

- **File references** — no path under `packages/`, `rome_apps/`, or `scripts/`, and no `.ts`, `.tsx`, or `.yaml` token. `[mech]`
- **Process steps** — how-to sequences are skills in `.claude/skills/`. These docs carry only what must hold on every diff. `[llm]`

  > Prefer: "Boot installs every packed first-party artifact."
  > Over: "1. Run the build. 2. Restart the daemon. 3. Confirm the app list."

## Eviction

The admission bar gates exit as well as entry: a sentence that stops clearing the local-correctness test leaves, and nothing stays for safety. A doc whose index line stops separating it from a sibling merges into the sibling. `[human]`

Eviction has two dispositions. A sentence that states a caller-observable contract moves to its concept entry in the same change. A sentence with no owner is deleted. When every invariant in a doc relocates or fails, the doc itself is deleted and its index line removed — an empty doc kept for future content fails the built-system rule. `[human]`

Trimming is part of every pass: any change that adds or edits a doc also states what it checked for removal. "Nothing qualifies" is a valid finding. Not checking is not. `[human]`

## Intake

When a review correction about a surface recurs, it exits through one of two doors: it becomes an invariant in the owning doc (or a rule here, if the miss was about authoring), or it is rejected in writing with the reason. Silent recurrence means the family is dead. `[human]`
