# Composition

A composition doc for the `@rome-os/ui` kit: how a component and a text run agree on a size when they share a row. [component-roles.md](component-roles.md) fixes which components line up with each other and what each role's members guarantee. This doc names the case that roster does not reach — a component standing next to text that belongs to no component. [semantic-token/typography.md](semantic-token/typography.md) owns which role a text run takes, and [CLAUDE.md](CLAUDE.md) defines the terms.

## Why size matching is a rule

A component height and a text line box come off two scales that nothing derives from each other. A row holding both takes the height of whichever is larger. A call site that picks a component size without naming the text beside it settles the row height by accident, and the next size change moves the row for a reason no one can read off the source.

## The two scales

A text run occupies its line box, not its font size. The box is the font size times its line-height step, from [line-height-primitives.md](primitive-token/line-height-primitives.md). Every box lands on the 4px grid.

| Text role | Font size | Line box |
|---|---|---|
| Auxiliary, Badge | 13px | 16px |
| UI Item | 14px | 20px |
| Section | 15px | 20px |
| Body | 16px | 20px |
| Title | 20px | 24px |
| Display | 30px | 36px |

A component occupies its declared height.

| Component | Steps |
|---|---|
| Control, inline | 28 (`sm`), 36 (`md`). Button family also 24 (`xs`), and 44 (`lg`) on its square members only |
| Badge | 22 |
| Avatar | 24, 32, 40 |
| Icon glyph | 14, 16, 20, 24 |

## Text inside a component

A member declares its own typography role, and a call site never sets a type utility on the member or its children. `[mech]`

### Air is a property of a pairing

**Air** is a component height minus the line box of the text inside it, split evenly above and below. Air belongs to the pair, never to either side alone. The same `md` control holds 16px of air around `text-ui` and 12px around `text-title`, so no step carries an air figure of its own. `[mech]`

Stating air per step is the error this section exists to prevent. Within one ladder at one role, air is the height minus a constant, which makes it a restatement of height rather than a fact about it. Air earns its keep only where the line box changes: across roles, and across the roles a single step is asked to hold.

### The ratio bound

Air divided by the line box it surrounds is the **air ratio**. A pairing holds a ratio at or under 1.0. `[mech]`

Past 1.0 the empty space outweighs the text it frames, and the component reads as inflated rather than prominent. The bound is falsifiable from the two scales alone, so a step that breaks it is a defect and not a preference.

| Pairing | Height | Line box | Air | Ratio |
|---|---|---|---|---|
| Control `xs` + UI Item | 24 | 20 | 4 | 0.20 |
| Control `sm` + UI Item | 28 | 20 | 8 | 0.40 |
| Control `md` + UI Item | 36 | 20 | 16 | 0.80 |
| Badge + Badge | 22 | 16 | 6 | 0.38 |
| Control `md` + Title | 36 | 24 | 12 | 0.50 |

A pairing under a 4px floor fails from the other side. The text then touches the box, and a descender clips against the border. `[mech]`

A control that renders no text has no pairing, so the bound does not reach it. An icon-only member still declares a role, because an em-sized glyph and a tooltip resolve against it, and it declares the role its step carries. `[mech]`

### A label caps how tall its control gets

The bound decides which steps may carry a label at all. A member holds one typography role, so a taller box spends the whole gain on air, and past a ratio of 1.0 the control reads as inflated rather than loud. Height is not one of the four sources of hierarchy [typography.md](semantic-token/typography.md) names. `[llm]`

> Prefer: a call to action at 36px leading through full width, primary ink, and its position in a dialog footer.
> Over: the same button at 44px, which holds the same 14px text in the same 20px line box and spends the extra 8px on air, at a ratio of 1.20.

The roster is what caps it. Escaping the bound at 44px needs a 24px line box, and the line-height formula puts every font size under 17px in a 20px box — so no role below Title moves the ratio at all. Title on a button is a heading on a control, which its usage statement rules out.

That is why 44px belongs to the square members alone. An icon control has no label, so no pairing, so no bound — and 44px is the touch floor it exists to clear.

## A component beside a text run

The row takes the larger of the component height and the anchor's line box. The anchor is the text that names the row — the label a reader looks for, not a trailing annotation. Pick the anchor's role first, from purpose, then take the component steps from its row here. `[mech]`

| Anchor role | Line box | Control | Avatar | Icon | Gap |
|---|---|---|---|---|---|
| Auxiliary | 16 | `sm` | 24 | 14 (`size-3.5`) | `gap-1` |
| Body, UI Item, Section | 20 | `sm` or `md` | 24 | 16 (`size-4`) | `gap-2` |
| Title | 24 | `md` | 32 | 20 (`size-5`) | `gap-2` |
| Display | 36 | `md` | 40 | 24 (`size-6`) | `gap-3` |

The icon steps are a lookup, not a formula. A glyph reads at its stroke weight rather than its em box, so it takes the step in the table and never one derived from the font size. `[mech]`

Inline content appears in no column of that table because it does not answer to the anchor. A `Badge` is 22px beside every role, and a `Badge` raised to a control height is the divergence [component-roles.md](component-roles.md#inline-content) names. `[mech]`

Two controls in one row agree through their size name alone, with no reference to this table. That agreement is the Control role's, not this doc's.

## Alignment axis

A row mixing a component with text centers on the cross axis. Every control centers its own content, so `items-center` on the row is the whole adjustment. `[mech]`

A row of two text runs at different roles aligns on the baseline. Centering two line boxes of different heights leaves the smaller run floating off the reading line. `[llm]`

> Prefer: a `text-title` heading and a trailing `text-aux` timestamp under `items-baseline`, both sitting on one reading line.
> Over: the same pair under `items-center`, which lifts the timestamp 4px above the heading's baseline.

A gap above 8px separates groups within a row, never a component from its own text. `[mech]`

## Stacking

A label above a control is a `Field`, and `Field` supplies the gap. No member of the stack sets a margin to space itself. `[mech]`

Vertical rhythm needs no pairing table. Every line box and every control height lands on the 4px grid, so a column of stacked rows stays on the grid whatever it holds.

## Examples

- Positive: a `text-ui` label, a 36px `Select`, and a 16px trailing icon in one row under `items-center` and `gap-2`. The row is 36px because the `Select` is. Moving the row to `sm` moves the label and icon with it, since neither carries a size of its own.
- Positive: an avatar at 24px, a `text-body` name, and a `text-aux` timestamp. The row is 24px, and the timestamp reads as annotation through ink rather than through a second row.
- Negative: a `text-title` heading given a 28px `sm` button beside it. The heading's 24px box leaves the button 4px of visual lead, so the button reads as an afterthought at the size a title-led row calls for `md`.
- Negative: a `text-aux` run raised to `text-ui` so it matches the button beside it. The row height does not change, because the button already set it. The only effect is one more thing at reading weight.
