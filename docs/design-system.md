# Design System

The dashboard (`packages/web`) and the component kit (`@rome-os/ui`) share one token system. This file holds the layer model, the token vocabulary, and the rules for writing UI against it. The per-dimension scales live in [`ui/`](ui/CLAUDE.md), and [`authoring/ui-tokens.md`](authoring/ui-tokens.md) governs those docs.

## Two layers

The system is two layers. The kit owns fixed values and the vocabulary. The
host owns runtime-swappable theme values.

**Layer 1 — values.** Plain custom properties. The kit declares theme- and mode-independent geometry and typography on `:root, :host`. The dashboard supplies theme-specific color and shadow values from `packages/web/src/lib/themes.ts` per theme × mode. Apps compile the fixed values into their bundle and inherit the active theme values through the Shadow DOM boundary. The `data-theme` attribute and `.dark` class select among theme value blocks, and every pointer downstream re-resolves.

**Layer 2 — vocabulary.** The `@theme inline` block in `packages/ui/src/styles.css` maps layer-1 values to generated utilities, so `--color-primary` becomes `bg-primary`. That stylesheet also carries the shared `@custom-variant` set and the base-layer element defaults, for every kit consumer alike — the dashboard and app bundles. A separate, non-inline `@theme` block defines the fixed typography-role scale. That block emits its variables on `:root, :host` so previews can override them. Both blocks are identical for every theme, and Tailwind's namespaces fix their key names: `--color-*`, `--font-*`, `--radius-*`, `--shadow-*`, `--text-*`.

Within layer 1, tokens are primitive or semantic.

**Primitive** tokens are the raw palette, named for the value: `--neutral-500`, `--red-400`, `--orange-300`. A primitive is never named for a role. It says what color it is, and which role reads it is the theme mapping's job.

The scale is a fixed set of 68 names, `--neutral-*` plus five hue ramps. Every theme carries all of them with its own values, so Ember's `--neutral-100` is warm linen and Slate's is a cool grey. These are plain custom properties, deliberately not in `@theme`, so Tailwind emits no utilities for the palette steps. See [`ui/primitive-token/color-primitives.md`](ui/primitive-token/color-primitives.md).

**Semantic** tokens are named by intent: `--background`, `--primary`, `--destructive`. Each source mapping points at a primitive step. The mapping is per theme, with a `light` and a `dark` half. That is what lets Ember map `--info` to its orange while Slate maps it to blue, without either primitive name lying.

The flow runs palette value → semantic token → `bg-*`/`text-*` utility in a component.

`buildThemeCss` (`packages/web/src/lib/theme.ts`) turns each `ThemeDefinition` into the per-theme blocks. It resolves the source mappings against that theme's palette. The palette and resolved light values go in `[data-theme="<id>"]`. The resolved dark values go in `[data-theme="<id>"].dark`. `injectThemeCss` then injects them into a runtime `<style id="rome-theme-tokens">`.

The palette rides in the light block because it spans both modes. A step number tracks lightness across the whole range, and the dark source mapping points semantic names at the deep end of the same ramps. Emission replaces palette references with the selected literals, so apps inherit semantic tokens without the palette. The kit's `:root, :host` block holds the theme- and mode-independent tokens. No file under `packages/web` declares them.

A token name has one declaring package. The token names declared under `packages/web` and `packages/ui` stay disjoint.

### Rules that keep the two layers sound

**No layer-1 token referenced by `@theme inline` may itself be a Tailwind theme key** — that is, a `<namespace>-<name>` under `--color-*`, `--font-*`, `--radius-*`, `--shadow-*`, or `--text-*`. Equivalently: every `@theme inline` entry that references a variable must use a different name than its own key. Never write `--x: var(--x)`.

Tailwind echoes referenced theme keys onto `:root, :host`. Inside an app ShadowRoot the `:host` half is the winning declaration on the mount element, so a same-name reference forms a CSS custom-property cycle there. The token computes to guaranteed-invalid, masks the inherited host value, and the utility silently no-ops. The light DOM never catches this, because the host's real declaration on `html` outranks the echo. The bug therefore ships green and breaks only in apps.

**Layer-1 naming** uses bare semantic names such as `--primary` and `--surface-muted` wherever they cannot collide with a theme key. That holds for all colors, since the `--color-` prefix buffers them.

Two cases need a prefix instead. The first is a natural name that would itself be a theme key, as with fonts and shadows. The second is a name that reads as a near-miss of one, where a typo turns it into a silent no-op. Prefix the backing token with `--rome-` and let the vocabulary map across: `--font-sans: var(--rome-font-sans)`, `--shadow-card-hover: var(--rome-shadow-card-hover)`, `--spacing-4: var(--rome-space-4)`. Do not blanket-prefix the colors — `var(--primary)` is the documented app-author contract and is collision-safe as-is.

Aliases are layer-1 pointers at other layer-1 tokens, such as `--card: var(--surface)`. `var()` resolves lazily at the element, so an alias declared once tracks every theme × mode swap without re-declaration.

**Only theme values cross the Shadow DOM boundary into an app.** Custom properties inherit, and inheritance cannot be narrowed. Every name the dashboard declares on `:root` reaches every app, whether or not the app was meant to see it. The promise is only the theme layer: the palette and the resolved semantic values `buildThemeCss` emits.

Everything else an app paints with holds the same value under every theme and mode, so the app carries it in its own bundle. Importing `@rome-os/app-web-sdk/styles`, or the kit sheet directly, is what puts it there. An app with no kit sheet declares the few constants it needs itself.

An app that reads a fixed value it never compiled renders correctly against the one host that declares it and breaks anywhere else. `packages/web/src/styles/app-token-contract.test.ts` fails on any `var()` an app cannot resolve from its own CSS, from a sheet it imports, or from the theme contract. A `var(--x, fallback)` is exempt, having stated its own default.

**Never ship a host-owned value in layer 2.** A literal theme color or shadow there forks the host's single source of truth. It also freezes that value into every consumer's compiled CSS. Fixed values belong in the kit's layer-1 block. The fixed typography-role scale belongs in a non-inline `@theme` block where Tailwind emits overridable variables.

**Control-geometry tokens (`--control-*`, `--field-*`, `--badge-*`) are layer 1 with no layer-2 entry, deliberately.** They get no `@theme` registration and no generated utility. Components read them in bracket form, such as `h-[var(--control-h-md)]`. That keeps the shared token greppable at every call site and classifies correctly under `tailwind-merge`. Values live in the kit's `:root, :host` block.

## Two axes: theme and mode

Color is selected by two orthogonal attributes on `<html>`.

- **Theme** — the `data-theme="<id>"` attribute, carrying which palette is active.
- **Mode** — the `.dark` class. Light against dark within the active theme.

Three themes ship, defined as `ThemeDefinition`s in `src/lib/themes.ts`. **Ember** is the default and warm. **Ash** is Ember cooled: near-neutral light surfaces, warm ink, and deepened coral accents that clear AA. **Slate** is cool grey with an ink accent. The set is open-ended, since `ThemeName` is `string`, so adding a theme is a data edit rather than a type or CSS change.

Each theme is a pair of generated blocks. `[data-theme="<id>"]` carries the palette and resolved light values. `[data-theme="<id>"].dark` carries resolved dark values. `buildThemeCss` emits both into the runtime `<style id="rome-theme-tokens">`.

The inline script in `index.html` seeds both attributes before first paint. It also replays the active theme's cached CSS, so the theme values are correct before the JS bundle loads. At runtime they are set through `useTheme()`: `setTheme` for theme and `setPreference` for mode, which call `applyThemeName` and `applyTheme` in `lib/theme.ts`. The registry seam is `getThemeDefinitions()`, the single function a future backend-served theme source would replace.

Dark mode is one half of a theme block, not a global. There is no bare `.dark` color block, because `data-theme` always selects the active palette first. Never add per-component dark or per-theme styling. A component built on semantic tokens already works in every theme and both modes.

Changing a primitive's value changes it for one theme only, which is what makes a theme a theme. Adding or removing a *name* changes the scale, so it lands in every theme at once.

### Adding a theme

1. Append a `ThemeDefinition` to `BUILTIN_THEMES` in `src/lib/themes.ts`, carrying an `id`, a `label`, a `palette`, and a `light` plus `dark` mapping. Copy an existing theme, retune the palette values, and adjust the mapping only where the new palette wants a different step.
2. Stop there. No CSS edits, no type changes, no component changes.

The picker, the runtime CSS injection, and the no-flash bootstrap are all data-driven off `getThemeDefinitions()`. App shadow roots inherit the host's active theme through the same inherited custom properties.

## Colors

Use semantic tokens in components: `bg-background`, `text-foreground`, `bg-surface`, `text-muted-foreground`, `border-border`, `bg-primary`, `text-destructive`, and `bg-success`/`bg-warning`/`bg-info`. The dialog and sheet scrim is `bg-overlay` (token `--overlay`), which bakes the alpha into the token. Use `bg-overlay` at full opacity rather than `bg-black/40`. The destructive and error token is `destructive`, not `danger`.

**Highlights and decorative emphasis use `primary` with alpha, not `accent` and not `brand`.** shadcn's convention is that `--primary` is the single strong color. It does interactive duty (`bg-primary` on Buttons, Switch checked, Tab active) and identity duty through alpha modulation: `bg-primary/5` for a selected card background, `bg-primary/15` for a brand badge, `text-primary` for a folder icon, `ring-primary/30` for a selection ring. `accent` is reserved for shadcn's neutral hover and selected background, so third-party shadcn apps render correctly.

**`brand` is a near-legacy alias for `primary`.** shadcn has no `--brand` token, and ours predates the strong-color discipline. New code uses `primary`. In Ember and Slate the two resolve to the same color, so existing `bg-brand` and `text-brand` call sites are visually correct and only need migrating.

Ash is the exception. Its `primary` deepened to clear AA on lighter surfaces while `brand` kept Ember's original coral, so the mark stays on-brand across themes. Migrating a `brand` call site there is a visible change, so check whether the site paints a logo or an affordance first. Add no new `bg-brand`, `text-brand`, or `border-brand` references.

Never reference a primitive directly in a component, such as `bg-[var(--neutral-‹step›)]`. Never reference a raw color either, whether `oklch(…)`, hex, or `bg-[#‹hex›]`. Theming and dark mode both rely on the semantic indirection. Primitives are referenced in exactly one place: the theme mappings in `src/lib/themes.ts`.

## Spacing, size, and radius

**Spacing is tokenized.** `--rome-space-*` in the kit's `styles.css` is the scale, and the kit binds it onto Tailwind's `--spacing-*` namespace. `p-4` and `gap-2` therefore resolve to Rome's values. Keep writing the utilities. The scale, its steps, and the reason it steps that way are in [`ui/primitive-token/spacing-primitives.md`](ui/primitive-token/spacing-primitives.md).

**Box size is tokenized.** `--rome-size-*` in the kit's `styles.css` is the scale behind the sizing utilities `size-*`, `h-*`, and `w-*`. Every step is a quarter-rem multiple, so the utility number is the step's px name divided by 4: `size-3.5` is `--rome-size-14` is 14px. Keep writing the utilities, but only numbers on the scale. Steps, bands, and the perceptual floors are in [`ui/primitive-token/box-size-primitives.md`](ui/primitive-token/box-size-primitives.md). Widths past the 64px ceiling, such as panels and sidebars, are region measures outside the scale.

**Shadow is tokenized.** The elevation scale `--rome-shadow-{1,4,10,25}` is theme data in `src/lib/themes.ts`, and its dark half deepens the ink. It binds to the `shadow-1`, `shadow-4`, `shadow-10`, and `shadow-25` utilities. See [`ui/primitive-token/elevation-primitives.md`](ui/primitive-token/elevation-primitives.md). Prefer a step over Tailwind's static `shadow-md` and friends, which are black at 10% and vanish in dark mode.

**Interactive control geometry is tokenized too.** The `--control-*` and `--badge-*` scale in the kit's `styles.css` is the single source of truth. It defines control height, padding, and radius. Which components must line up with each other is fixed by [`ui/component-roles.md`](ui/component-roles.md).

| Step | `--control-h-*` | `--control-r-*` | `--control-px-start-*` | `--control-px-center-*` | Carried by |
|---|---|---|---|---|---|
| `sm` | 28px | 8px | 10px | 8px | every Control member |
| `md` | 36px | 10px | 12px | 12px | every Control member |
| `lg` | 44px | 12px | 16px | 16px | `Button` / `IconButton` only |

The tokens are the whole scale. Which members *offer* a step is a separate question, answered under *Sizes* below.

`--control-gap` is 8px, one value for every size, and `--badge-h/px/gap` covers badges. The role utilities own typography, never the control geometry scale.

**Horizontal padding follows the content's alignment, not the component.** There are two groups, and every Control member reads one of them rather than a raw spacing step.

`--control-px-start-*` is for content that begins at an alignment edge: Input, Textarea, SelectTrigger, CommandInput, and any `Button` given `align="start"` or `align="between"`. Content starts reading there, so everything non-centred in one column lines up on it.

`--control-px-center-*` is for **centred** content, which is not an edge because nothing lines up against it: a default `Button`, a `SegmentedControl` segment, a `TabsTrigger`. It is a token rather than each component's own step so that one size name still means one inset across the members that share it — a `Button` and a segment at `md` pad the same.

The groups agree at `md` and `lg` and diverge at `sm`, where a start edge takes 10px to keep a field's text off its border and centred content takes 8px. Both set symmetric padding. Neither word names a side.

Two members sit outside the groups. `Button size="xs"` is 24px, below the scale, and neither group carries an `xs` step, so it pads from a spacing step. `TabsTrigger` has no size axis and its list is 32px, between the shared heights — it takes the `sm` centred step, recorded as a divergence in [`ui/component-roles.md`](ui/component-roles.md#known-divergences) rather than pretending to fit. The vertical inset on Textarea, the one control that pads vertically at all, is a spacing step too, with nothing to agree with.

Padding is symmetric everywhere: no member trims the icon side. Optically correcting a glyph against the padded edge is a separate change, not a per-component judgement call.

Do not hand-write `justify-start` on a `Button`. Reach for `align`, which carries the matching padding. A start-aligned button with centred padding is 2px off every field above it at `sm`, and nothing catches that by eye.

`--field-px-*` still resolves as an alias of `--control-px-start-*`. Write no new references to it.

These are tokens rather than Tailwind steps because the steps are shared across primitives. `h-9` on a Button and `h-9` on an Input agree only by coincidence, and that coincidence is what kept drifting. `Button`, `Input`, `SelectTrigger`, `Textarea`, `SegmentedControl`, and `Badge` all read them. A button, a field, and a chip on the same row therefore line up by construction.

**Sizing a control means reading the scale, not picking a Tailwind step.** Write it in bracket form: `h-[var(--control-h-md)]`, `px-[var(--control-px-start-md)]`, `rounded-[var(--control-r-md)]`. Do not use Tailwind v4's parenthesis shorthand. The two forms compile to identical CSS, and both classify correctly since `cn` became a re-export of the kit's merger (`@rome-os/ui/cn`, on `tailwind-merge` 3.x). Bracket form stays the house style because it keeps the token name greppable at every call site. Sanity check before committing a new one: `twMerge("h-[var(--control-h-md)]", "h-9")` must return just `h-9`.

Controls set an explicit height and pad horizontally only. Height is specified, so `border-box` absorbs a border on that axis. Width grows with the label, so a border added there widens the box. Every control that can paint a border declares the width unconditionally, and a variant changes only the color. `packages/ui/src/border-layout-invariant.test.ts` enforces both halves.

### Sizes

**The shared size vocabulary is two steps, `sm` (28px) and `md` (36px), and each means the same height on every control.** `Button`, `Toggle`, `Input`, `SelectTrigger`, `SegmentedControl`, and `IconButton` all read the `--control-h-*` step of the name they were given. A row that names one size therefore cannot come out ragged. `Button` and `Input` still accept `default`, and `Button` accepts `icon`, as the older spellings of `md` and `icon-md`. Both resolve to the same geometry. Write `md`.

**`lg` (44px) and `xs` (24px) belong to the Button family, not the shared vocabulary.** `Button` and `IconButton` carry them. `Input`, `SelectTrigger`, and `SegmentedControl` do not, on purpose.

They are prominence steps. Every `lg` in the tree is a standalone call to action: a `w-full` login button, a dialog footer, a page-header action. Every `xs` is a chip beside body text. Neither ever shares a row with a field, so neither needs the cross-component agreement `sm` and `md` carry. Reach for `lg` when the button *is* the screen's commitment, not to make a row taller.

**Two ladders offer a square icon button at every step, and the overlap is deliberate.** `IconButton`'s steps and `Button`'s `icon-*` variants are value-identical, with the same height and the same radius. Reach for `IconButton` by default, because its required `label` prop makes an icon-only control accessible by construction rather than by reviewer vigilance. Reach for `Button size="icon-sm"` and friends in two cases. The first is a control needing a `Button` variant the icon primitive has no equivalent for, such as `ghost`'s `aria-expanded` paint or `destructive`. The second is a control sitting in a `ButtonGroup`.

**Text inputs use `text-body` at every width.** Body is 16px, so what a reader types matches the prose it becomes rather than the controls around it, and a field clears the threshold below which iOS Safari zooms the viewport on focus. Its line box is 20px, the same as the controls beside it, so a field still sits on their rhythm. Do not introduce a mobile size exception.

Adding a control step works like adding a token. It goes in `packages/ui/src/styles.css` first, then every primitive that needs it reads it. Do not inline a fourth height.

`--radius` is a kit compatibility token, not one for Rome's own components, which keep using Tailwind's numbered `rounded-*` utilities. The shared `@theme inline` radius ladder in `@rome-os/ui/styles.css` is calculated from it.

**Prefer a preset utility over an arbitrary value.** Reach for the nearest step on the scale, such as `text-sm` or `p-3`, before an arbitrary raw-length utility. The codebase still has arbitrary values in places. Add no more, and collapse them toward presets when you are already editing the line.

**A repeated arbitrary value is an implicit token.** If the same arbitrary value appears in two places — `text-[10px]`, `tracking-[0.32em]`, a bespoke `shadow-[…]` — it is a token nobody wrote down. Collapse it back to the nearest preset, which is almost always possible, or take it through *Adding tokens* below. One-off arbitrary values are fine, and duplicated ones are a smell.

## Adding tokens

For a color the palette already has, add the **semantic** token to every theme in `src/lib/themes.ts`. That means the `light` and `dark` mapping of each built-in theme, each pointing at the appropriate primitive step. Then add a matching `--color-<token>: var(--<token>)` line to the `@theme inline` block in `packages/ui/src/styles.css` so Tailwind emits the utility. Use the semantic token in the component.

The behavioral tests in `lib/theme.test.ts` catch two mistakes here. They fail when a token exists in one half of a theme but not the other. They also fail when a mapping reaches a primitive its theme's palette lacks.

**A token that carries text needs a pairing in `lib/themes-contrast.test.ts`.** That gate resolves every declared pairing to concrete colors per theme × mode and holds it to WCAG AA: 4.5:1 for text, 3:1 for a focus edge.

Its `PAIRINGS` roster is the list of what the system promises will be legible. A new `-foreground` or fill partner belongs in it, as does a new text role on a surface. The file's header states the admission bar and what is deliberately out of scope. Pairings that ship below the bar are recorded there with their measured ratio and tracked in issue #2167. Re-point a semantic token at a deeper step rather than adding a record.

For a value the palette does not have, add the step to every theme's `palette`. The scale is the same set of names under every theme. A step that exists in one theme and not another is therefore a broken theme, not a partial rollout. Give each theme its own value, interpolating between neighbours where a theme has no opinion, then point the semantic token at it.

Palette values are literals. Never `var(...)` one palette entry at another, which re-couples the themes into a shared palette — the thing per-theme values replace. `color-mix(...)` over a literal and shadow lists are fine. The source mapping writes `var(...)`, and `buildThemeCss` resolves it before emission.

**A primitive name says what the value is, never what reads it.** Write `--red-400`, not `--critical-solid`. If a step can only be named by naming the role that reads it, it belongs in the mapping.

Add a step or token only when a theme mapping actually needs it. Do not pad the ramps or predict future tokens.

## Typography

The typeface stacks are tokens, declared once on `:root, :host` in the kit's `styles.css`. They are theme- and mode-independent, so they sit in no `[data-theme]` block. The literals live on `--rome-font-{sans,serif,mono}` backing tokens, because a bare `--font-*` name is a Tailwind theme key. `--font-{sans,serif,mono}` are reader-facing aliases of them. Use them through Tailwind's `font-sans` and `font-mono` utilities, which the kit's `@theme inline` wires to the backing tokens.

That block is the single source of truth for every bundle's fonts. Do not paste a font-family literal into a host component or the app-host shell. Reference `var(--font-*)` instead. App Tailwind `font-*` utilities resolve through the same kit stylesheet.

**UI text has no micro tier.** Micro-labels and chart apparatus such as axis ticks and tooltip annotations use `text-aux`. If a chart API cannot accept a class name, pass the Auxiliary role's `--text-aux` custom properties instead of a raw size.

**Decorative text may opt out of the role scale when its size defines the artwork's geometry.** It must not label, explain, or report anything. The ASCII art in `SettingsTabPage.tsx` is the host bundle's one 10px exception.

**No decorative small-caps.** Do not use `uppercase` with `tracking-wider`, `tracking-widest`, or `tracking-[…em]` for section labels, column headers, category captions, badges, or design-system micro-headings. It is the highest-frequency LLM-UI tell, costs readability for zero information, and does not fit this product's surface. A small label is `text-xs text-muted-foreground`, adding `font-medium` if it really needs weight, and a column header is the same. Code, ID, and hash display in `font-mono` is fine, as long as `uppercase` and wide tracking are not stacked on top.

## Components

**Use shadcn primitives from `@/components/ui`:** Button, Dialog, DropdownMenu, Popover, Select, Tooltip, Switch, Textarea, Badge, Skeleton, Field, IconButton, Tile, Stepper, Sortable, Alert, Breadcrumb, and more. Run `ls src/components/ui` before writing UI. Do not reach for raw `<button>`, `<input>`, or `<select>` when the primitive exists. The primitive carries token wiring, focus rings, size variants, and accessibility, and bypassing it silently drops all of that.

**Some `ui/` files are one-line re-export shims.** Three groups live in `@rome-os/ui`, which apps can import too:

- the control primitives — button, badge, input, textarea, switch, separator, skeleton, field, icon-button, tabs, segmented-control
- the floating family — dialog, sheet, popover, dropdown-menu, tooltip, context-menu, select
- the `command` composite, plus `alert` and `card`

Import sites are unchanged. Edit the source in `packages/ui/src/<name>.tsx`, and remember that a change there is a change to a published package. It takes a Conventional Commit, and every consumer inherits it. `sortable`, `data-table`, `mobile-backdrop`, and `safari` are dashboard-private and stay in `packages/web`.

**A missing primitive goes into `ui/`, never hand-rolled in the page.** If `ui/` lacks what you need, check [shadcn's registry](https://ui.shadcn.com/docs/components) first, since most cases already exist as a recipe: Tabs, Avatar, Accordion, Calendar. Drop one in with `pnpm dlx shadcn@latest add <name>`, re-wire its colors to our semantic tokens, and commit it under `ui/`. Only if shadcn lacks it too, write a new `ui/` primitive, Radix-based for anything with interaction, focus, or keyboard semantics.

**`Tabs` against `SegmentedControl` is decided by whether each choice owns a panel.** `Tabs` is underline-only and means the tablist and tabpanel contract, where each `TabsTrigger` reveals its own `TabsContent`. If the choice instead switches, filters, or reframes one view, with no panel per choice, use `SegmentedControl`. It paints a muted track with the active segment lifted onto the canvas. It is a radiogroup rather than a tablist, so assistive tech is not told to look for panels that do not exist. `SegmentedControl` is controlled-only and requires an `aria-label`.

**A pressed toolbar button is `Toggle` (`@rome-os/ui/toggle`), not a `Button` with a hand-rolled `aria-pressed`.** `Toggle` owns `aria-pressed` and the pressed paint, and `variant` only picks the unpressed resting look. `Switch` stays the form control, for a setting the user is editing. There is no `ToggleGroup` — one-of-N is `SegmentedControl`.

**The "duplicate three times" rule does not apply to interactive primitives.** Static layout duplication can wait. A second handwritten Tabs, Avatar, or Tooltip is already too many, because fragmented keyboard, ARIA, and focus behavior is the cost. Promote on the second occurrence.

**No wrapper layer between `ui/` and Radix.** Business-specific shells such as `RomeConfirmDialog` are fine, but they compose `ui/dialog.tsx` internally. Never import `DialogPrimitive` or another Radix primitive directly to re-style overlay or content. The `ui/` primitive is the only place Radix gets dressed.

**Icons come from `lucide-react` only.** Do not define `function FooIcon()` returning an `<svg>`, and do not write `<svg>` inline as an icon. If lucide lacks a glyph, check shadcn and lucide first. Brand and logo marks live in their dedicated directories, `components/brand-icons/` and `components/logo/`, rather than scattered in pages.

## Focus and invalid states

Both are one 2px `outline`, never a translucent halo. It sits just outside the control at `outline-offset: 0`, so it separates from the canvas rather than from the control's own fill. An outline never affects layout:

```
focus-visible:outline-solid focus-visible:outline-2
focus-visible:outline-offset-0 focus-visible:outline-ring
```

Three things are load-bearing and easy to get wrong.

- **`outline-solid` is required.** The base `outline-none` these components carry sets `--tw-outline-style: none`, and Tailwind's `outline-2` emits `outline-style: var(--tw-outline-style)`. Without it the outline computes to `none` and focus renders invisible.
- **The edge must stay outside the box.** Every theme points `ring` at a neighbouring step of the same ramp as `primary`, `secondary` and `input`, so an inset edge lands on a control's fill at 1.08:1 and disappears. `themes-contrast.test.ts` records those three pairings.
- **Do not draw focus with `ring-*` or with a border recolor.** Forced colors mode drops `box-shadow` and keeps `outline`, so a ring leaves a keyboard user in High Contrast with no indicator at all. A border recolor is layout-safe, but it makes the indicator depend on a border being present, so removing that border for a visual reason halves focus with nothing reporting it.

`aria-invalid` gets the same treatment in `destructive`. When a field is both invalid and focused, the destructive edge wins, because Tailwind orders the `aria-*` variant after `focus-visible`. That is deliberate: the error stays visible while the user is fixing it.

Roughly 55 hand-rolled `focus-visible:ring-*` call sites in pages and shell components are not yet converted. They sit mostly on raw elements rather than `ui/` primitives. Convert them as you touch them.

## Component gallery

`/dev/gallery` is a specimen page for every `ui/` primitive, covering variants, sizes, and states. Theme switches (Ember, Ash, Slate) and mode switches (light, dark, system) drive it through the real `lib/theme` helpers.

It is one of the dev-only routes: `src/pages/dev/`, registered in `dev-routes.ts` and linked from the `/dev` index. It therefore renders outside `AuthGate`. Run `pnpm start:web` and open `/dev/gallery` with no backend and no auth. The theme switchers write the dashboard's own stored preference, so a theme picked there is the theme the rest of the app renders in.

Nothing there reaches a production bundle. `DEV_ROUTES` is the empty array when `import.meta.env.DEV` is false, and the page's `lazy(() => import(...))` is constructed only inside that dead branch. The chunk is never emitted. The specimens import the real components and the real `globals.css`, so what renders is what ships.

Reach for it when changing a `ui/` primitive or a token. A value defined in only one half of a theme shows up as a broken specimen immediately. Add new primitives to the matching section under `src/pages/dev/gallery/sections/`. A stale specimen fails `pnpm typecheck`.
