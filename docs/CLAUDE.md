# `docs/`

Durable design documentation for Rome. [README.md](README.md) maps what lives where, and the per-content-type rulebooks live in [`authoring/`](authoring/authoring.md).

## Playbook

- Before writing any prose in `docs/`, read [authoring/WRITING.md](authoring/WRITING.md) — terminology, word choice, verbs, sentences, structure.
- After changing prose in `docs/`, run `pnpm lint:prose`. Vale checks the rules from WRITING.md that a machine can decide, against the baseline in `scripts/prose-baseline.mjs`. The same check covers comments in `.ts` and `.tsx` sources.
- Before writing a rulebook for a content type, read [authoring/authoring.md](authoring/authoring.md) — the format, admission, eviction, and intake it must carry.
- When writing an entry in `concepts/`, `principles/`, or `architecture/`, read that family's rulebook: [authoring/concepts.md](authoring/concepts.md), [authoring/principles.md](authoring/principles.md), [authoring/architecture.md](authoring/architecture.md).
- When recording a standing decision — the choice, the rejected alternatives, and the forces between them — write an ADR in [`adrs/`](authoring/adrs.md), one file per decision keyed by filename.
- When filing a GitHub issue, read [authoring/github-issues.md](authoring/github-issues.md).
- When writing a `CLAUDE.md`, read [authoring/claude-md.md](authoring/claude-md.md).
- When writing a token doc, read [authoring/ui-tokens.md](authoring/ui-tokens.md).

## Traps

**A section that names a mechanism instead of an invariant reads as documentation and cannot be applied to a diff.** Each section in `concepts/` and `architecture/` names an invariant between components — a rule a contributor uses to decide whether a change is allowed — statable without reference to any file, type, or function.

Prefer:

> The routing and agent layers cannot observe which external channel a message originated from. All channel-specific specifics are absorbed by the channel adapter.

Over:

> We have a `ChannelAdapter` interface that each channel implements.

The first sentence is the contract. The second is the mechanism that enforces it, and it belongs in code review.

**Design context written into `docs/` outlives the change and rots there.** The design context of an in-flight change lives in its PR description ([authoring/prs.md](authoring/prs.md)). A decision that keeps constraining diffs after the change ships gets an ADR, and the rest stays in git history.
