# Design Token Docs

[`../ui/`](../ui/primitive-token/color-primitives.md) holds the token docs, one directory per kind of token: [`primitive-token/`](../ui/primitive-token/color-primitives.md), [`semantic-token/`](../ui/semantic-token/surfaces.md), and [`component-token/`](../ui/component-token/README.md). Each holds one primitive doc per dimension, one semantic doc per token or role group, or one spec per component.

[component-roles.md](../ui/component-roles.md) sits beside the three directories. It is not a token doc: it fixes which components must line up with each other and what each role's members guarantee, and every component spec is written against it.

Three rulebooks own the tokens, one each: [ui-primitive-tokens.md](ui-primitive-tokens.md), [ui-semantic-tokens.md](ui-semantic-tokens.md), and [ui-component-tokens.md](ui-component-tokens.md). A rulebook owns what its tokens hold, when one enters or leaves, and the format of the docs in its directory. Read the one for the doc you are writing.

This file holds the rules every token doc shares: the terminology, the reference direction, the shared format, and the deprecation notes. A rule lives here or in one rulebook, never in both. Tier tags come from [authoring.md](authoring.md). The prose rules for all of `docs/` come from [WRITING.md](WRITING.md). The repo-wide doc-writing rules come from [../AGENTS.md](../AGENTS.md).

## Terminology

Every token doc uses the term in the left column. A forbidden synonym never appears. `[mech]`

| Term | Definition | Forbidden synonyms |
|---|---|---|
| primitive token | A raw, context-free value, such as `neutral-500` or `spacing-4` | base token, core token, global token |
| scale | The ordered set of primitive tokens on one dimension: color, spacing, type | ramp, table |
| palette | The values one theme supplies for a scale, one per primitive name | — |
| semantic token | A token named for its purpose, aliasing a primitive token, such as `bg-surface` | alias token, slot, semantic variable |
| theme mapping | The primitive token a semantic token resolves to under a given theme | assignment |
| component token | A token scoped to one component, aliasing a semantic token, such as `table-row-alt-bg` | component variable |
| component role | A set of components sharing one size scale and one alignment contract, such as Control or Surface | category, class, family |
| role contract | The clause set every member of one component role holds to | guarantees, rules |
| anatomy | The breakdown of a component into parts that each consume tokens independently | structure, regions |
| variant | A named alternative presentation of a component sharing one anatomy, such as `primary` or `ghost` | style, kind |
| interaction state | A transient condition of a component part that drives token substitution: hover, active, focus, disabled | state shift |

The aliasing direction runs component token to semantic token to primitive token. Every doc links to this line instead of restating it. `[mech]`

A token is a named value, not a mechanism. A custom property, a Tailwind utility, and a kit stylesheet entry carry tokens equally. No doc calls a dimension untokenized because a tool supplies its values. `[mech]`

Token names and code identifiers appear in their original form, wrapped in inline code. `[mech]`

## Reference direction

A component spec references only semantic token docs. A semantic token doc references only primitive token docs. `[mech]`

[component-roles.md](../ui/component-roles.md) sits outside that direction. A component spec references it, and it references whichever token docs its contracts rest on. `[mech]`

## Shared format

Every doc names its type and its subject in the first line, and links to its rulebook there. It carries every section its type requires. A doc may add sections. It may not omit one. `[mech]`

A rule in a doc carries a tier tag, on the terms [authoring.md](authoring.md) sets for one. A description of the tokens — a usage statement, a mapping, a property of the scale — carries none. `[mech]`

A token doc or component spec stays under 800 words, not counting the rows of a token or mapping table. When it passes that, split it. `[mech]`

## Deprecation

A token that stops clearing the admission bar in its rulebook leaves. `[human]`

Removal runs through a deprecation note, not a deletion. The token stays in place in its doc and the note sits directly beside it, in one of two forms. `[mech]`

> ⚠️ **Deprecated** — use `<replacement-token>` instead. <One-line substitution rule, such as "Drop-in replacement.">

> ⚠️ **Deprecated** — no replacement. <One-line fallback, such as "Retain existing usage. Add no new usage pending redesign.">

When a replacement exists, the note names it. When none exists, the note takes the second form and states the fallback. `[mech]`

New usage never references a token that carries a deprecation note. `[mech]`

Once no usage remains, delete the token from its doc. `[human]`

The fallback never directs a consumer to break the aliasing direction. `[llm]`

> Prefer: "Retain existing usage. Add no new usage pending redesign."
> Over: "Reference `--neutral-200` directly until the replacement lands."

## Intake

A correction that recurs and touches every doc type equally becomes a rule in this file, or the maintainer rejects it in writing and states the reason. A correction about one doc type routes to that type's rulebook. Silent recurrence means this file is dead. `[human]`

Where a token doc or a per-type rulebook conflicts with this file, this file wins. `[human]`
