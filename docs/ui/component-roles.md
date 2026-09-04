# Component Roles

A component-role doc for the `@rome-os/ui` kit: which components must line up with each other, and what each guarantees so that lining up needs no per-pair coordination. [../authoring/ui-component-tokens.md](../authoring/ui-component-tokens.md) is the rulebook for the specs the roles govern. [../authoring/ui-tokens.md](../authoring/ui-tokens.md) defines the terms. A component holds exactly one role.

## Why roles

An alignment claim is unfalsifiable until membership is written down. Absent the roster a component drifts onto a neighbouring scale one call site at a time — a `Badge` given a control height because it read well beside a `Button` once, then 36px tall inside every table cell after that. The roster is what makes that a violation rather than a preference.

## The roster

| Role | Owns | Members |
|---|---|---|
| [Control](#control) | Height, padding, radius, focus edge | Inline: `Button`, `IconButton`, `Input`, `CommandInput`, `SelectTrigger`, `SegmentedControl`, `Toggle`, `TabsTrigger`, Calendar `button_previous` and `button_next`, Calendar dropdown triggers, `CalendarDayButton`. Future: the Combobox, DatePicker and SearchField triggers. Block: `Textarea` |
| [Selection control](#selection-control) | An intrinsic size off the control scale, and a hit area larger than its box | `Switch`, plus `Checkbox` and `Radio` when they land |
| [Surface](#surface) | Radius, elevation, padding, separation from the layer below | `Card`, `Tile`, `Alert`, `PopoverContent`, `DropdownMenuContent`, `ContextMenuContent`, `SelectContent`, `TooltipContent`, `Toaster`, `Dialog`, `Sheet` |
| [Inline content](#inline-content) | A smaller scale of its own | `Badge`, `Avatar`, `Spinner`, Calendar `weekday`, `week_number_header`, and `week_number`. Future: `Kbd` and `Tag` |
| [Layout](#layout) | All spacing between its children | `Field`, `FieldGroup`, `ButtonGroup`, Calendar `months`, `month`, `nav`, `table`, `weekdays`, and `week` |
| [Table section](#table-section) | Row-group boundaries | `TableHeader`, `TableBody` |
| [Table row](#table-row) | Row separation and interaction-state fill | `TableRow` |
| [Table cell](#table-cell) | Cell inset, alignment, header typography | `TableHead`, `TableCell` |

`Tile` still lives in `packages/web`. The kit stages it for a later move. It already holds a role here, so the move carries no reclassification.

## Control

A control takes pointer or keyboard input directly. A member is **inline** or **block**, and only inline members compose in a row.

- An inline member holds a fixed height and sits beside its neighbours: `Button`, `IconButton`, `Input`, `CommandInput`, `SelectTrigger`, `SegmentedControl`, `Toggle`, `TabsTrigger`. `[mech]`
- A block member fills its column and takes its height from its content: `Textarea` today. `[mech]`

### Every member

- Padding is horizontal and symmetric, taken from a token, never from a raw spacing step. Which token follows from how the content sits: a member whose content starts at an alignment edge takes `--control-px-start-*`, and a member whose content is centred takes `--control-px-center-*`. Height is specified, so `border-box` absorbs a border there. Width is not. A member that can paint a border declares the width unconditionally, and a variant changes only the color. `[mech]`

  The start inset is shared because it is an alignment edge: it is where content starts reading, so every such member stacked in one column lines up on it. A centred label is not an edge — nothing lines up against it — so the centre group is free to sit tighter, and it is a group rather than each component's own step so that one size name still means one inset across the members that share it. The two agree at `md` and `lg` and diverge at `sm`.

  Alignment is the axis, not component kind. A `Button` rendered start-aligned is on the shared start inset. A `SelectTrigger` would be on the centre group if it ever centred its value. The check is the component's own alignment, so it can be read straight off the source. `[mech]`

  No member trims one side for a glyph sitting there. An optical correction is a decision for the whole role, not a per-component one, and until the role makes it the padding stays symmetric. `[mech]`
- Radius is a `--control-r-*` step. `[mech]`
- The focus edge is one geometry throughout: a 2px `outline` in `--ring` at `outline-offset: 0`, sitting outside the box. It stays outside because `ring` and the control fills sit a step apart on one ramp, so an inset edge does not separate from them. A translucent halo (`focus-visible:ring-*`) never appears. `[mech]`
- A member carries no margin, and sets no fixed width. Spacing belongs to Layout. `w-full` reaches the outermost element. `[mech]`
- Geometry is written in bracket form — `h-[var(--control-h-md)]`, never `h-(--control-h-md)` — so `tailwind-merge` classifies it and a caller's `className` wins. `[mech]`
- Typography is a role utility (`text-ui`, `text-body`), never derived from the size step. `[mech]`

### Inline members

The role exists for these: any two at the same size, dropped into one row, are the same height and centered against each other with no adjustment at the call site.

- A size name is a composition contract before it is a lookup. The same name on any two members yields the same outer height. A member that omits a name cannot join a row at that size. It does not fall back to the nearest step. `[mech]`
- **The shared vocabulary is two steps: `sm` (28px) and `md` (36px).** Every member carries both, names them from that set and no other, and takes the matching `--control-h-*` and `--control-r-*` step. A member with a private spelling for a shared height is the divergence this clause prevents, whatever pixel it lands on. `[mech]`

  Two, because two is what mixed rows use. A census of every call site in `packages/web` and `rome_apps` puts 270 of 292 on `sm` or `md`, and those are the only steps more than one kind of member is ever asked for.

- **`lg` (44px) and `xs` (24px) are the Button family's, and are not part of the shared vocabulary.** `Button` and its square twin `IconButton` carry them. A field, a select, or a switcher does not. `[mech]`

  They are not alignment steps, which is why the role does not bind them. `xs` is a chip beside body text, and a member sizing one sizes it square, off `--rome-size-24`. Neither shares a row with a field, so neither exercises the agreement the shared steps exist for.

  **Only the square members carry `lg`: `IconButton` and `Button`'s `icon-lg`.** It is a 44px hit area for an icon control, not a prominence step for a label. A labelled `Button` has no `lg`, because every step carries one typography role — so a taller box around one line of text buys air rather than emphasis, and air past the line box it surrounds reads as inflation. See [composition.md](composition.md#air-is-a-property-of-a-pairing). `[mech]`

- Height is one step of `--control-h-*`, and the radius step matches it. No member takes a height from another source. `[mech]`
- A step reaches a member's public API when a call site needs it, not to complete a set. A name no caller can use is a promise the role has to keep for nothing. `[mech]`
- A member centers its own content on the cross axis, so a row of same-size members needs `items-center` on the row and no per-member nudging. `[mech]`
- An adornment inside the control — a leading icon in a field, a trailing chevron — consumes the horizontal padding, never the height. `[mech]`
- A member whose smallest step falls under 44px names `.touch-target` as its pairing for touch-reachable surfaces. `[mech]`

### Block members

- Height comes from content, above a floor. `Textarea` grows by `field-sizing-content` from `min-h-16`. A block member never reads `--control-h-*`. `[mech]`
- Vertical padding is a spacing step, taken directly — no other control has a vertical inset to agree with. `[mech]`
- A size name governs padding, radius, and typography — never height, so a block member joins no row's size agreement. `[mech]`

## Selection control

A switch or checkbox reads as a glyph, not as a box. Sizing one to a control height makes it the loudest thing in a form row.

- Size is intrinsic and off the control scale. `Switch` is 18×32px at `default`, 14×24px at `sm`. `[mech]`
- The hit area reaches the touch floor through a pseudo-element (`after:-inset-*`), never through the box, so the row height stays the label's. `[mech]`
- Width is never fillable, and a member is labelled by a sibling, never by text of its own. `[mech]`
- The focus edge is the Control clause above, unchanged. `[mech]`

## Surface

A surface frames content. It has no size of its own, and its radius and elevation state how far it floats above what it covers.

- No intrinsic size. Content or the caller sizes a surface. A `w-*` a member sets is a default the caller overrides. `[mech]`
- Elevation states depth, and only depth: none in flow, `shadow-4` floating, `shadow-10` floating above a floating layer, `shadow-25` modal. `[mech]`
- Radius states box magnitude, not depth, and nests concentrically — see [border-radius-primitives.md](primitive-token/border-radius-primitives.md). A surface anchored to a viewport edge carries none on the anchored edge. `[mech]`

| Depth | Members | Radius | Elevation | Separation |
|---|---|---|---|---|
| In flow | `Card`, `Tile`, `Alert` | `rounded-8`–`rounded-12` | none | `border` |
| Floating | `PopoverContent`, `DropdownMenuContent`, `ContextMenuContent`, `SelectContent` | `rounded-12` | `shadow-4` | `ring-1 ring-foreground/10` |
| Nested floating | `DropdownMenuSubContent` | `rounded-12` | `shadow-10` | `ring-1 ring-foreground/10` |
| Transient overlay | `Toaster` | `rounded-8` | `shadow-4` | `border` |
| Modal | `Dialog` | `rounded-16` | `shadow-25` | `border` and `ring-1` |
| Modal, edge-anchored | `Sheet` | none | `shadow-25` | `border` on the anchored edge |
| Transient | `TooltipContent` | `rounded-8` | none | inverted fill |

The two middle columns agree across most rows because a modal is a large box and a tooltip is a small one — not because either drives the other. `DropdownMenuSubContent` rises an elevation step at an unchanged corner, and `Sheet` sits at the deepest step with no corner at all.

- A floating member separates with a shadow *and* a ring, never fill alone — two theme pairs collapse `--surface` onto `--surface-elevated`, per [surfaces.md](semantic-token/surfaces.md). `[mech]`
- Padding comes from the spacing scale. A surface exposing named parts (`CardHeader`, `DialogFooter`) puts the inline padding on the parts, so a part can bleed to the edge. `[mech]`
- A surface holds no height contract with a control: a dialog footer is as tall as its buttons. `[mech]`

## Inline content

Inline content sits inside a line of text or a table cell. It answers to the text around it, not to the buttons beside it.

- The scale is the member's own, never `--control-h-*`. `Badge` reads `--badge-h` (22px), `--badge-px`, `--badge-gap`. `Avatar` reads a square 24 / 32 / 40px step. `[mech]`
- A member is center-alignable in a line of text and in a table cell without raising the row height. `[mech]`
- Typography is `text-aux` or smaller, never `text-body`. `[mech]`
- Interactivity does not promote the role. A clickable `Badge` gains the Control focus edge and nothing else — not the height, not the padding, not the radius step. `[llm]`

> Prefer: a dismissible `Badge` at `--badge-h`, 22px tall in a table cell, carrying a focus edge.
> Over: the same badge raised to `--control-h-sm` so it matches the button beside it, and 28px tall in every cell thereafter.

## Layout

A layout component owns the space between its children and has no appearance of its own.

- No fill, no border, no radius, no shadow, and no text of its own. `[mech]`
- It sets no height and contributes none beyond its children. `[mech]`
- A container with an appearance of its own is not Layout. `SegmentedControl`'s track fills and rounds, so it is one Control, not a layout around three. `[mech]`
- `ButtonGroup` is the one member permitted to restyle its children, collapsing the adjoining radii and borders of the controls inside it. `[mech]`
- All spacing between siblings comes from a layout component (`gap-*`, `space-y-*`). No sibling sets a margin to space itself. `[llm]`

> Prefer: `Field` supplying the gap between a label and its input.
> Over: `FieldLabel` supplying `mb-1`, which every other consumer of that label then has to undo.

The kit ships no general `Stack`, `Row`, or `Grid`. Spacing between arbitrary siblings is a raw `flex` and `gap-*` at the call site until those land.

## Table section

A table section groups rows and decides where the group boundary appears.

- A section sets no height, padding, typography, or fill. Rows and cells own that geometry. `[mech]`
- `TableHeader` separates each header row. `TableBody` removes the separator after its last row. `[mech]`

## Table row

A table row separates one record from the next and carries record-level interaction states.

- A row sets no height or padding. Its cells determine its geometry. `[mech]`
- A row draws the bottom separator. Hover and selected fills cover the whole record. `[mech]`

## Table cell

A table cell aligns content within a shared column.

- A cell owns its inset and vertical alignment. A row never duplicates either value. `[mech]`
- The composite sets the shared table typography. A header cell owns the header-row height and uses muted Auxiliary typography. `[mech]`
- A body cell takes its height from content plus its vertical inset. `[mech]`
- Inline content keeps its own scale inside a cell. A `Badge` never takes a `--control-h-*` height to size the row. `[mech]`

## Composites

A composite takes no role. Each of its parts takes one. `Select` is a Control (`SelectTrigger`) and a Surface (`SelectContent`), exported separately for exactly this reason. `Command` follows the same composition: `CommandInput` is the Control, while its caller-owned `PopoverContent` or `Dialog` is the popup Surface. The `Command` root is not rostered as a role of its own. `Tabs`, `Calendar`, `Table`, and `DataTable` decompose the same way. `[mech]`

`Calendar` has this anatomy. The names match its `classNames` keys, except for the exported `CalendarDayButton`. State names such as selected, today, outside, and range start or end modify `day` or `CalendarDayButton`. They are not additional parts. The chevron is a Control adornment, and the inner week-number wrapper belongs to `week_number`. `[mech]`

| Part | Role |
|---|---|
| `button_previous`, `button_next`, the month and year trigger formed by `dropdown_root` + `dropdown` + dropdown-mode `caption_label`, `CalendarDayButton` | Control |
| `months`, `month`, `nav`, `table`, `weekdays`, `week` | Layout |
| `weekday`, `week_number_header`, `week_number` | Inline content |
| `root`, `dropdowns`, `month_caption`, label-mode `caption_label`, `day` | Unassigned — `root` and `day` paint backgrounds. `dropdowns` also sets inherited type. The static caption is `text-ui`. None meets one existing role contract. |

## Cross-role rules

- Every component the kit exports, and every `packages/web` component staged to move in, appears in exactly one roster row or under [Unassigned](#unassigned). `[mech]`
- A component reads only its own role's scale. `[mech]`
- Changing a component's role is a breaking change to its geometry, and moves it in the roster in the same commit. `[human]`

### Glyph size

Any component that holds a glyph, in any role.

- The component sets the size, never the call site. A component that renders or receives an `<svg>` and leaves it unsized has no default — it has whatever each caller happened to write, which is how the same chip ended up at 12px and 14px in one tree. `[mech]`
- A glyph tracks the box it sits in, not the label beside it. `Button` is the ladder: its text is `text-ui` at every size while its glyph runs 12 / 14 / 16 / 16 across the 24 / 28 / 36 / 44px boxes — a half-box at the two small steps, then held at 16px. Pick from that ladder, and where half a box is not a step, take the next one up: `Badge` is 22px and takes 12px. `[mech]`
- A member with a size axis carries the glyph on that axis, so `sm` and `md` differ. `Button`, `IconButton`, `Input`, `SelectTrigger`, and `SegmentedControl` all give 14px at `sm` and 16px at `md`, which is what keeps a field and a button on one `sm` row from disagreeing about their glyphs. `SegmentedControl` reads the track, not the segment, for the same reason its height does: the track is the box that joins the row. `[mech]`
- A component never writes a size on a glyph it hands to something else to hold, because that opts the glyph out of the holder's rule. `Calendar`'s one `Chevron` renderer feeds both a nav button and the dropdown caption. Sizing it there would give the two rows one number and make each host's rule dead. `[mech]`
- A member with no size axis takes the glyph of the step it already pads on, rather than deriving a second answer from its own box. `TabsTrigger` is the case: its 32px list sits between the shared heights, it takes the `sm` centred inset, and so its glyph is `sm`'s 14px. Padding at one step and sizing the glyph at another is the drift this rule exists to stop. `[mech]`
- The default stands aside for a caller's own `size-*`, and the opt-out lives in the selector: `[&_svg:not([class*='size-'])]:size-N`. It has to. The caller's class lands on the `<svg>` while the rule lives on the parent, and `tailwind-merge` reconciles one element at a time, so `cn` never sees the collision. Only that spelling opts out — `h-4 w-4` leaves the rule matching, and the rule wins on specificity, (0,2,1) against (0,1,0). `[mech]`
- A component that reserves room for the glyph sizes that reserve from the glyph, not from a repeated literal. `Alert` holds its icon column at `auto` rather than `1rem`, and `Toaster`'s icon slot takes its width from its child, so a caller who opts out widens the reserve instead of overflowing it. `[mech]`
- A component whose reserve *cannot* follow the glyph offers no opt-out, and says so where the rule is written. Two in-tree. `EmptyStateIcon` normalizes to 20px because its 44px tile is fixed and a `Spinner` tops out at the 16px `md` step, which would leave the waiting tile smaller than the nothing-found tile it stands in for. `Input` normalizes to its step because it reserves the glyph's room as `padding-left` on the `<input>` beside it, and no CSS makes one element's padding track another element's width. The test for whether a component owes an opt-out is therefore mechanical: can its reserved geometry follow? `[mech]`
- A host that resizes a member's box names the step that box measures, rather than overriding the geometry under a step it does not occupy. `Calendar`'s nav buttons are `--cell-size`, which is the same 28px as `--control-h-sm`, so they name `icon-sm` — otherwise the default `md` supplies a 16px glyph and a 10px radius to a 28px control. `[mech]`

## Unassigned

Naming the gap beats a wrong assignment.

| Component | Why it holds no role yet |
|---|---|
| `Separator` | Draws a hairline, so it is not Layout. Carries no scale, so it is not Inline content. |
| `Skeleton` | Takes the shape of whatever it stands in for, so it inherits that component's role at the call site. |
| `Markdown` | Renders author-controlled prose from its own stylesheet, sized and spaced by the document flow rather than by a role scale. |
| Calendar `root`, `dropdowns`, `month_caption`, label-mode `caption_label`, `day` | Calendar parts that do not meet one existing role contract. See [Composites](#composites). |
| `Command` | Composite root. Deliberately takes no role of its own. |
| `CommandEmpty`, `CommandGroup`, `CommandItem`, `CommandList`, `CommandSeparator` | Internal states, grouping, rows, scrolling, and separators of the `Command` composite. The caller-owned popup boundary is its Surface. |
| `EmptyState`, `Stepper` | Not yet surveyed against the contracts. |
| `Breadcrumb` | Its default `text-ui` typography violates the Inline content contract. Its `BreadcrumbEllipsis` collapse marker is 20px tall and raises the row at the required `text-aux` line height. The marker only represents omitted crumbs, so its presentation-only semantics do not change the role decision. The 14px separator fits that role, but the composite cannot take a role until all parts fit. |

## Known divergences

In-tree today. Each is a conflict the roster exposes, not a rule it grants.

| Divergence | Detail |
|---|---|
| `CommandInput` exposes no size | Fixed at the `md` step, so a row containing it cannot be resized as a unit. `Textarea` has none either, but as a block member only its padding and typography are at stake. |
| `CommandInput` paints no focus edge | The only Control member without one. Its row is a full-bleed header inside `Command`'s `overflow-hidden`, so the role's edge — 2px at `outline-offset: 0`, outside the box — is drawn beyond the clip and cut away on three sides. The geometry the role fixes cannot render at this position. Independently, `cmdk` holds focus in the input for the whole life of the surface, so an edge keyed to it would be lit permanently and would mark nothing; its one transition is a tab to a trailing control and back. The header reads against the list by `border-b-border`, and trailing controls keep their own edges. Reinstating the edge means first moving the row off the clip boundary. |
| No adornment slot on `Input` | A leading icon is hand-positioned at five `packages/web` call sites (`absolute left-3 top-1/2 -translate-y-1/2`), each picking its own icon size and its own compensating left padding. |
| Off-scale control steps | `Button size="xs"` and `IconButton size="xs"` are 24px, and `TabsList` is 32px. Neither is a `--control-h-*` step. The `xs` pair is deliberate and stated above. `TabsList` is not. |
| Two members pad off the groups | Both follow from the row above. `Button size="xs"` pads from a spacing step, because neither padding group carries an `xs`. `TabsTrigger` takes the `sm` centred step: it has no size axis, and its 32px list sits between the shared heights, so the step is picked rather than looked up. |
| Two spellings of the `md` step | `Button` and `Input` still accept `default`, and `Button` still accepts `icon`, as the pre-vocabulary names for `md` and `icon-md`. Both resolve to the same geometry and normalize to the canonical name in `data-size`. They are deprecated, not a second step. |
| `Input` offers an `lg` nothing uses | 44px is a square icon-control hit area, and no field has ever been asked for one. Deprecated rather than removed, since the kit is published. |
| `Button` names seven sizes for four steps | The `icon-*` half exists so `Button` can do `IconButton`'s job, and 11 of its 14 call sites are `variant="ghost"` with no `ButtonGroup` — which `IconButton` already covers, with a required `label`. Consolidating needs a `variant` prop on `IconButton` first. |
| Calendar controls use cell geometry | Navigation buttons, dropdown triggers, and day buttons read the 28px `--cell-size` rather than a `--control-h-*` step. Dropdown triggers also lack the shared focus edge. |
| No token doc behind the Control contract | `--control-*`, `--field-*`, and `--badge-*` live in the host's `:root` with only a reference table in `packages/ui/src/styles.css`. The Control clauses above are what a semantic doc for them would carry. |

## Examples

- Positive: an email `Input` with a leading mail icon inside it, and an "Add" `Button`, in one row at the same size name. The row is a `flex` with `items-center` and nothing else. The icon rides the field's padding. Changing the size name moves all three together.
- Negative: a new member that names its 28px step `small`, or names a 32px step `sm`. One word then means two heights across the kit — `items-center` centers a ragged row instead of aligning it, and the fix that gets reached for is a hand-tuned height at the call site rather than the step the member should have taken.
- Negative: `Badge` given `h-[var(--control-h-sm)]` so it matches a neighbouring button. It now sets the row height of every table it appears in, and no test fails.
