# Primitive Tokens

This file owns the **primitive tokens** — what one holds, when one enters or leaves — and the format of the **primitive token docs** in [`../ui/primitive-token/`](../ui/primitive-token/color-primitives.md). [ui-tokens.md](ui-tokens.md) defines the terms, holds every rule the token docs share, and wins where a rule here conflicts with it.

## What a primitive is

A primitive holds a literal, or an expression over primitives on its own dimension, and reads no other token. Its name describes the value, such as `--neutral-500` or `--rome-space-4`, never the use, such as a hover fill or a menu transition. `[mech]`

Every literal lives in a primitive. No semantic token and no component carries one of its own. `[mech]`

The [aliasing direction](ui-tokens.md#terminology) decides who reads a primitive. On a dimension with no semantic tokens, a component reads the primitive through the utility bound to it. `[mech]`

## Token docs

Twelve dimensions carry a scale.

| Dimension | Why a scale | Doc |
|---|---|---|
| Color | Continuous OKLCH space, so near-duplicates are endless without a fixed ramp | [color-primitives.md](../ui/primitive-token/color-primitives.md) |
| Spacing | Continuous px and rem, where nothing separates 15px from 16px | [spacing-primitives.md](../ui/primitive-token/spacing-primitives.md) |
| Box size | Continuous, and a near-miss between two boxes reads as misalignment, not a size | [box-size-primitives.md](../ui/primitive-token/box-size-primitives.md) |
| Font size | Continuous, carrying the same drift risk as spacing | [font-size-primitives.md](../ui/primitive-token/font-size-primitives.md) |
| Line height | Continuous and often unitless, and small differences compound down a page | [line-height-primitives.md](../ui/primitive-token/line-height-primitives.md) |
| Letter spacing | Continuous, small in magnitude, and easy to drift | Not written |
| Border radius | Continuous | [border-radius-primitives.md](../ui/primitive-token/border-radius-primitives.md) |
| Elevation | Continuous across offset, blur, spread, and opacity together | [elevation-primitives.md](../ui/primitive-token/elevation-primitives.md) |
| Opacity | Continuous from 0 to 1 | Not written |
| Motion duration | Continuous milliseconds | Not written |
| Motion easing | Continuous bezier space | Not written |
| Z-index | Discrete, but an unconstrained integer space with no natural stopping point | Not written |

Letter spacing and font weight hold their values inside the [typography roles](../ui/semantic-token/typography.md), which the every-literal rule above does not allow. Each carries too few distinct values across the roster for a scale to separate anything. The other unwritten dimensions resolve to values Tailwind ships. `[human]`

## Format

One doc per dimension. Required sections: Tokens, How the scale is built, Forbidden usage. `[mech]`

A primitive doc states what a token is — its name, its value, and the rationale for that value — never what it serves. Purpose belongs to the semantic tokens that alias it, and lives in their docs. A sentence whose subject is a token and whose predicate is a consumer or a role is a usage statement. A value's rationale may still cite the demand that fixed it. `[llm]`

> Prefer: "`--neutral-550` sits at 5.2:1 on `--neutral-25`, the depth where a muted-text token clears AA."
> Over: "`--neutral-550` serves muted text in Ash."

### Tokens

Every ramp or group on the dimension, and every token's name and value. A dimension with one flat scale has one group. A dimension on an adopted scale names that scale in place of a listing. `[mech]`

A group states its values one of two ways: a table listing every token with its value, or a single derivation rule when every name encodes its value, such as a step number times a base. A derivation rule still names the steps that exist, because a scale skips steps. `[mech]`

### How the scale is built

The rationale for the chosen values: the rule behind step density and spacing, and what fixed any value the rule alone does not place. That rule is either a formula, such as a perceptually uniform color space, or on-demand growth one step at a time. `[mech]`

The section is a list. Each item opens with a bold sentence stating one claim about the scale. `[mech]`

A stated reason rests on a measured property of the scale, never on an intent no one recorded. `[llm]`

> Prefer: "the lightness gap between neighbors runs from .001 to .33, so a ramp is not an even scale."
> Over: "the ramp is tuned for perceptual smoothness."

### Forbidden usage

What the scale refuses. Each item is one refusal sentence and carries its own tier tag. `[mech]`

The section covers the call site: which consumers may read the dimension, what a call site may never write, and what a value may never encode. `[mech]`

## Admission

A dimension earns a scale when skipping one would produce visible inconsistency. The test is the value space: a continuous space, or an integer space with no natural stopping point, lets near-duplicates pile up until surfaces drift apart. A dimension whose values are already few and discrete earns nothing. `[human]`

A step enters a scale only when a consumer needs it — a semantic token where the dimension has them, a component otherwise. Nothing rounds out a scale. `[human]`

A scale earns a doc when Rome states its values in the repo. Values the delivery tool ships leave nothing to document. `[human]`

A doc enters by replacing the unwritten marker in its roster row with a link. `[mech]`

## Eviction

A step leaves when no consumer points at it, and takes a [deprecation note](ui-tokens.md#deprecation). `[human]`

A dimension leaves when it stops clearing the admission bar. The roster drops the row, and the doc goes with it. `[human]`

## Intake

A correction that recurs across primitive docs either becomes a rule in this file, or the maintainer rejects it in writing and states the reason. Silent recurrence means this file is dead. A rule enters only after the practice it codifies appeared in two or more primitive docs. `[human]`

Where a primitive doc conflicts with this file, this file wins. `[human]`
