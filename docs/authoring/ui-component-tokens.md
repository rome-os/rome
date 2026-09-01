# Component Tokens

This file owns the **component tokens** and the format of the **component specs** in [`../ui/component-token/`](../ui/component-token/README.md). [ui-tokens.md](ui-tokens.md) defines the terms, holds every rule the token docs share, and wins where a rule here conflicts with it.

No component spec exists yet. Every rule below predates the first spec, which means no rule here has been tested against one. The first spec is the test. A rule that the first spec cannot satisfy leaves this file rather than forcing the spec. `[human]`

## Format

One doc per component. Required sections: When to use, Anatomy, Token table, Interaction states, Component tokens, Examples. `[mech]`

The first line names the component's role and links to [../ui/component-roles.md](../ui/component-roles.md). A spec states what is true of the one component. A clause that holds for every member of the role lives in the roles doc, never in both. `[mech]`

### When to use

One line in the form "Use for ____. Use `<OtherComponent>` instead when ____." `[mech]`

A coding agent picks the right component from this section alone, without reading the rest of the spec. `[llm]`

> Prefer: "Use for a short confirmation the reader can dismiss. Use `Dialog` instead when the reader must answer before continuing."
> Over: "Use for notifications and other transient messages."

### Anatomy

The parts, each classified as surface, text, border, or interactive. `[mech]`

### Token table

The full variant by part table, resolving to semantic tokens. A primitive never appears in it. `[mech]`

### Interaction states

How hover, active, focus, and disabled substitute tokens or move along the scale. `[mech]`

### Component tokens

Each token names its justification: local deviation, external theming interface, or multi-brand remapping. A token that fits none of the three fails admission. `[mech]`

### Examples

At least one positive and one negative. `[mech]`

## Admission

A component earns a spec when both hold: `[human]`

1. A consumer picks between the component and a neighbor, and the When to use line separates the two.
2. The component carries a variant, an interaction state, or a component token that a reader cannot derive from the semantic tokens alone.

A component that consumes semantic tokens directly, with no variant and no component token, needs no spec. `[human]`

## Eviction

A spec leaves when its component leaves the kit, or when it stops clearing the admission bar. `[human]`

A component token that leaves takes a [deprecation note](ui-tokens.md#deprecation). `[human]`

## Intake

A correction that recurs across specs either becomes a rule in this file, or the maintainer rejects it in writing and states the reason. Silent recurrence means this file is dead. Once two or more specs exist, a rule enters only after the practice it codifies appeared in two of them. `[human]`

Where a spec conflicts with this file, this file wins. `[human]`
