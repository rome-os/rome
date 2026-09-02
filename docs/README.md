# docs/

Durable design documentation for Rome. For the rules used when writing docs, see [CLAUDE.md](CLAUDE.md).

## What lives where

- [`VISION.md`](../VISION.md) (repo root) — why Rome exists, posture constraints, scope.
- [`concepts/`](concepts/index.md) — domain entity definitions. The single source of truth for what each term means.
- [`architecture/`](architecture/index.md) — the components on each surface and the invariants binding them.
- `adrs/` — records of standing decisions, one file per decision keyed by filename. [authoring/adrs.md](authoring/adrs.md) defines the family.
- [`authoring/`](authoring/authoring.md) — the rulebook for each content type (docs, PRs, issues, ADRs, design tokens, code comments, CLAUDE.md files) plus the cross-cutting prose rules.
- [`northstars/`](northstars/CLAUDE.md) — ideal-state docs, one per area: what should be true, checked against the codebase by the `loop-reconcile` skill.
- [`ui/`](ui/CLAUDE.md) — the design token docs, one directory per kind of token. [authoring/ui-tokens.md](authoring/ui-tokens.md) holds the rules they share.
- `research/` — cited findings that answer an open question in an issue, grouped by topic. Each note names the issue it serves; the issue, not the note, carries the decision.

Other top-level files in `docs/` are operational references paired with the surface they document — [`design-system.md`](design-system.md), [`ui-kit.md`](ui-kit.md), [`dashboard-mock-mode.md`](dashboard-mock-mode.md), [`releases.md`](releases.md), [`observability/`](observability/). Rome Cloud deployment operations live in the private [`amantru/rome-cloud`](https://github.com/amantru/rome-cloud) repository.

## Why docs

In AI-coding workflows the bottleneck is the cost of communication, not the cost of producing code. The context code derives from — why Rome exists, what the system promises, what each term means — has to live in the repo, where AI reads it. Docs capture that context durably.

Docs state what is true *now*. ADRs record *why* each standing decision was made and what it rejected. Keeping the *why* separate keeps the load-bearing context free of stale designs.
