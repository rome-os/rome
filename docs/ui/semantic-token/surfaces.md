# Surfaces

A semantic token doc for the surface role group. [ui-semantic-tokens.md](../../authoring/ui-semantic-tokens.md) is the rulebook. A surface token sets the fill of a region, never its text.

The roster: `--background`, `--chat-canvas`, `--app-canvas`, `--surface`, `--surface-muted`, `--surface-elevated`, `--surface-hover`, `--card`, `--popover`, `--color-sidebar`, `--overlay`.

Rome renders two context canvases plus three content depths: a raised card, a floating layer above the card, and a region recessed inside a card. `--card` and `--popover` are aliases, not depths of their own. `[mech]`

## Why this name

Each token names where a region sits in the stack, never how light the region is. The stack reverses between modes, so a name built on lightness would invert. `--surface-muted` names a recessed region and resolves to a step lighter than the canvas in dark mode. `[llm]`

> Prefer: `--surface-elevated` on a popover, because a popover floats above the card it opened from.
> Over: `--surface-elevated` on a hero band, because white matches the mockup.

## Usage statement

- `--background` — Used for dashboard pages without a dedicated canvas role. Not used when chat or app context identifies the canvas.
- `--chat-canvas` — Used behind a chat transcript and its composer. Not used for an app page.
- `--app-canvas` — Used behind compact app UI and readable content. Not used inside chat.
- `--surface` — Used for a raised card, panel, or table row floating on the canvas. Not used for the canvas.
- `--surface-muted` — Used for a region recessed inside a card: a well, a code block, a table header. Not used for a region that floats.
- `--surface-elevated` — Used for the highest layer: popovers, menus, floating panels. Not used for a card sitting in the page flow.
- `--surface-hover` — Used for the hover and active fill of a row or list item. Not used as a resting fill.
- `--card` — Used by shadcn-derived primitives that expect a `card` token. Not used directly in Rome code, which writes `--surface`.
- `--popover` — Used by shadcn-derived primitives that expect a `popover` token. Not used directly in Rome code.
- `--color-sidebar` — Used by Streamdown, which frames code and table blocks with `bg-sidebar`. Not used by Rome's own sidebar, and not backed by a layer-1 token: the kit binds it straight to `--surface`.
- `--overlay` — Used for the dialog and sheet scrim. Not used at partial opacity, because the translucency is baked into the token.

## Theme mapping

Ash's dark half maps the same steps as Ember's, against its own palette. Every theme gives the [`--neutral-*` scale](../primitive-token/color-primitives.md) its own values. Where two columns name the same step, the themes agree on the depth, never on the color.

| Token | Ember light | Ember dark | Ash light | Slate light | Slate dark |
|---|---|---|---|---|---|
| `--background` | `--neutral-50` | `--neutral-950` | `--neutral-50` | `--neutral-50` | `--neutral-950` |
| `--chat-canvas` | `--neutral-50` | `--neutral-950` | `--neutral-50` | `--neutral-50` | `--neutral-950` |
| `--app-canvas` | `--neutral-25` | `--neutral-950` | `--neutral-25` | `--neutral-0` | `--neutral-950` |
| `--surface` | `--neutral-25` | `--neutral-925` | `--neutral-25` | `--neutral-0` | `--neutral-900` |
| `--surface-muted` | `--neutral-100` | `--neutral-850` | `--neutral-150` | `--neutral-100` | `--neutral-850` |
| `--surface-elevated` | `--neutral-0` | `--neutral-850` | `--neutral-0` | `--neutral-0` | `--neutral-850` |
| `--surface-hover` | `--neutral-200` | `--neutral-750` | `--neutral-100` | `--neutral-100` | `--neutral-750` |

`--overlay` resolves to a `color-mix` expression rather than to a step. `--card` and `--popover` alias other tokens and carry no mapping of their own. `--color-sidebar` is a kit-level binding onto `--surface` with nothing behind it. `[mech]`

## Constraints

- The chat canvas is never white. Its warm or cool tint keeps long-form reading comfortable. `[mech]`
- `--chat-canvas` deliberately equals `--background` today. The separate name pins context so chat and generic dashboard pages can diverge without another component migration. `[mech]`
- The app canvas may resolve to white. Compact UI needs a brighter reading plane than chat prose. `[mech]`
- A card may share the app canvas fill. Its border and grouping must carry the boundary when the fills collapse. `[mech]`
- A control painted with `--background` may likewise share its enclosing card's fill inside an app. Its input border or control edge must remain sufficient without fill contrast. `[mech]`
- The stack reverses between modes where its fills differ. In light a canvas is darker than a card, and a recessed region is darker still. In dark every distinct layer rises from the canvas. `[mech]`
- Two pairs collapse in some themes. Slate light resolves `--surface` and `--surface-elevated` to the same white, and every dark half resolves `--surface-muted` and `--surface-elevated` to the same step. A layer that must read as floating carries a border or a shadow, never fill alone. `[mech]`
- `--surface-hover` states a transient fill. A row at rest takes `--surface`. `[mech]`
- A fill changes only alongside its foreground partner. `[mech]`

## Examples

- Positive: a code block inside a chat card set to `bg-surface-muted`. It reads as recessed in light, and it stays the recessed role in dark, where the step is lighter than the canvas.
- Positive: a dense repository list set directly on `bg-app-canvas`, with dividers and spacing carrying its rows.
- Negative: a dropdown panel set to `bg-surface` with no border. It looks right in Ember light, where the card step sits below the elevated step. In Slate light both resolve to white, so the panel dissolves into the card behind it.
- Negative: an app page set to `bg-chat-canvas`, which gives 14px UI copy the reading plane intended for 16px chat prose.
