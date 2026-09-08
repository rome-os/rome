# `docs/ui/`

The design token docs. One directory per kind of token: `primitive-token/` (one doc per dimension), `semantic-token/` (one doc per token or role group), and `component-token/` (one spec per component). [`component-roles.md`](component-roles.md) and [`composition.md`](composition.md) sit beside them. Neither is a token doc. The first fixes which components must line up with each other and what each role's members guarantee. The second covers the case that roster does not reach: what size a component takes when the thing beside it is a text run rather than another component.

[`VOICE.md`](VOICE.md) and [`secondary-text.md`](secondary-text.md) govern the words rather than the pixels. The first fixes how every string a guardian reads sounds. The second decides whether a piece of secondary text exists at all, and the `secondary-text-audit` skill reads it as its ruleset.

## Playbook

- Before writing or editing any doc here, read [`authoring/ui-tokens.md`](../authoring/ui-tokens.md). It holds the terminology, the reference direction, the shared format, and the deprecation notes every token doc shares.
- Before writing or changing any string a guardian reads, read [`VOICE.md`](VOICE.md). It wins over [`authoring/WRITING.md`](../authoring/WRITING.md) for anything rendered in a UI.
- When the doc is a primitive token doc, also read [`authoring/ui-primitive-tokens.md`](../authoring/ui-primitive-tokens.md). For a semantic token doc, [`authoring/ui-semantic-tokens.md`](../authoring/ui-semantic-tokens.md). For a component spec, [`authoring/ui-component-tokens.md`](../authoring/ui-component-tokens.md) and [`component-roles.md`](component-roles.md), which every component spec is written against.
- When a rule here conflicts with a per-type rulebook, [`authoring/ui-tokens.md`](../authoring/ui-tokens.md) wins.
