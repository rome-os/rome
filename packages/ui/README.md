# `@rome-os/ui`

The shared React component kit for Rome surfaces. One published package that the
dashboard, first-party apps, and scaffolded external apps all import, instead of
each copying shadcn components by hand and drifting apart.

> **Status: filling up.** The publish rail, the CSS canon (`./styles.css`), the
> [control primitives](#controls), the [floating family](#floating-family),
> [`Alert`](#alert), [`Card`](#card), [`Spinner`](#spinner),
> [`Timestamp`](#timestamp), [`Toaster`](#toaster), [`Calendar`](#calendar),
> [`Command`](#command), and [`Markdown`](#markdown) are in. The remaining containers land in follow-up
> tickets. The app scaffold (`packages/app-template/template`) depends on the
> published package, so a release here reaches external apps.

## Install

```bash
pnpm add @rome-os/ui
```

React 19, `react-dom`, and `lucide-react` are peer dependencies — the host
provides them, so the kit never ends up with a second copy of React in the
bundle.

## Import

```tsx
import { cn } from "@rome-os/ui/cn"; // subpath export
import { cn } from "@rome-os/ui"; // or the barrel
```

Every component gets its own subpath export (`@rome-os/ui/button`). Prefer the
subpath in app code so a bundler never has to reach the whole kit to find one
component. Components backed by optional peers stay out of the barrel.
[`Markdown`](#markdown) needs Streamdown, [`Calendar`](#calendar) needs
`react-day-picker`, [`Command`](#command) needs `cmdk`, and [`Toaster`](#toaster)
needs `sonner`.

The stylesheet is a single import at the host's CSS entrypoint:

```css
@import "@rome-os/ui/styles.css";
```

`Markdown` adds a second, opt-in one — see below.

## Components

### Controls

The non-floating primitives. Each takes a `className` that wins over its own
variant classes, so a host restyles one without forking it.

| Subpath | Exports |
| --- | --- |
| `@rome-os/ui/badge` | `Badge` |
| `@rome-os/ui/button` | `Button`, `buttonVariants` |
| `@rome-os/ui/field` | `Field`, `FieldGroup`, `FieldLabel`, `FieldGroupLabel`, `FieldDescription`, `FieldError`, `FormError` |
| `@rome-os/ui/icon-button` | `IconButton` |
| `@rome-os/ui/input` | `Input` |
| `@rome-os/ui/segmented-control` | `SegmentedControl` |
| `@rome-os/ui/separator` | `Separator` |
| `@rome-os/ui/skeleton` | `Skeleton` |
| `@rome-os/ui/switch` | `Switch` |
| `@rome-os/ui/tabs` | `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` |
| `@rome-os/ui/textarea` | `Textarea` |
| `@rome-os/ui/toggle` | `Toggle` |

Height, padding, radius, and type size come from the kit's `--control-*` /
`--field-*` / `--badge-*` custom properties, so a `Button` and an `Input` on the
same row line up under any theme. `Tabs` owns a panel per choice; reach for
`SegmentedControl` when the choices switch or filter a single view.

**On/off controls — pick by where it sits.** `Switch` is the form control: a
setting in a settings panel, a value the user is editing. `Toggle` is the
toolbar one: a button that stays pressed. `SegmentedControl` is one-of-N, not
on/off.

```tsx
import { Toggle } from "@rome-os/ui/toggle";

<Toggle pressed={autoStart} onPressedChange={setAutoStart}>
  Auto-start ready tickets
</Toggle>;
```

- Controlled only — `pressed` and `onPressedChange` are both required.
- The component owns `aria-pressed` and the pressed paint; the props type
  refuses `aria-pressed`, so the accessible state can't drift from what the
  toggle looks like. `variant` (`ghost` | `outline`) picks the *unpressed*
  resting look only.
- `size` is `Button`'s vocabulary, read off `buttonVariants` — a `Toggle` and a
  `Button` at the same size are the same height by construction, not by
  coincidence.
- Single-select among N is `SegmentedControl`; there is deliberately no
  `ToggleGroup`.

### Floating family

Everything that renders a layer above the page. Radix under the hood — focus
trap, dismissal, keyboard semantics — dressed in Rome's tokens.

| Subpath | Exports |
| --- | --- |
| `@rome-os/ui/context-menu` | `ContextMenu`, `ContextMenuTrigger`, `ContextMenuContent`, `ContextMenuItem`, `ContextMenuLabel`, `ContextMenuGroup`, `ContextMenuSeparator` |
| `@rome-os/ui/dialog` | `Dialog`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogBody`, `DialogFooter` |
| `@rome-os/ui/dropdown-menu` | `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuItem`, `DropdownMenuCheckboxItem`, `DropdownMenuRadioGroup`, `DropdownMenuRadioItem`, `DropdownMenuLabel`, `DropdownMenuSeparator`, `DropdownMenuShortcut`, `DropdownMenuSub…`, `dropdownMenuItemVariants` |
| `@rome-os/ui/popover` | `Popover`, `PopoverTrigger`, `PopoverAnchor`, `PopoverContent`, `PopoverHeader`, `PopoverTitle`, `PopoverDescription` |
| `@rome-os/ui/select` | `Select`, `SelectTrigger`, `SelectValue`, `SelectContent`, `SelectItem`, `SelectGroup`, `SelectLabel`, `SelectSeparator`, `SelectScrollUpButton`, `SelectScrollDownButton` |
| `@rome-os/ui/sheet` | `Sheet`, `SheetTitle`, `SheetDescription` |
| `@rome-os/ui/tooltip` | `Tooltip`, `TooltipProvider`, `TooltipTrigger`, `TooltipContent` |

**They portal to the right root on their own.** A Rome app renders inside a
Shadow DOM, and its compiled CSS lives in that shadow root — so the usual
`document.body` portal would drop the layer outside the app's styles and paint
it half-dressed. Each of these resolves its container from where the component
sits in the tree: inside a shadow root it portals into that root (under the
element the host toggles theme classes on), and in a plain document it takes
Radix's `document.body` default. Nothing to pass, nothing to configure — an
app-authored component still reaches for the SDK's `getPortalContainer()`, but
kit components never need it.

### Command

`Command` is an opt-in composite built on `cmdk`: a search field, filtered list,
and keyboard-selectable items. Install `cmdk` only in consumers that use it,
then import the subpath directly:

```bash
pnpm add cmdk
```

```tsx
import { Command, CommandInput, CommandItem, CommandList } from "@rome-os/ui/command";
```

It intentionally has no barrel entry, so consumers of the rest of the kit do
not need to install or resolve `cmdk`.

### `Alert`

A bordered panel for a status message the user has to read — a failed
connection, a warning before a destructive step, a success confirmation.

```tsx
import { Alert, AlertDescription, AlertTitle } from "@rome-os/ui/alert";
import { PlugZap } from "lucide-react";

<Alert variant="destructive">
  <PlugZap />
  <AlertTitle>GitHub is disconnected</AlertTitle>
  <AlertDescription>Reconnect to keep syncing your repositories.</AlertDescription>
</Alert>;
```

- Five variants — `default` (neutral surface), `info`, `success`, `warning`,
  `destructive` — each painted from one `*-bg` / `*-border` / `*-fg` token trio,
  so a host theme restyles all five by moving those tokens.
- Carries `role="alert"`, so assistive tech announces it when it appears.
- A leading `<svg>` (any lucide icon) is optional: the grid opens its icon
  column only when one is present, and the icon inherits the variant's `fg`.

### `Card`

shadcn's `card` (new-york-v4) restyled to Rome's panel surface: `surface` fill,
a `border` hairline, `rounded-lg`, flat (no shadow). The anatomy is upstream's
— same part names, same `data-slot` attributes, same header grid — so a copied
shadcn card swaps for this one without touching JSX:

```tsx
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@rome-os/ui/card";

<Card>
  <CardHeader>
    <CardTitle>Delivery</CardTitle>
    <CardDescription>Where your briefing lands each morning.</CardDescription>
  </CardHeader>
  <CardContent>Sent to Telegram at 7:00.</CardContent>
</Card>;
```

- The Card owns the vertical inset and the spacing between parts; the parts pad
  horizontally only. A Card with no header is inset exactly like one with a
  header — no `pt-0` bookkeeping at the call site.
- `CardAction` is the header's trailing cell (a badge, a switch, a menu
  trigger); the header only opens that column when an action is present.
- A header carrying `border-b` restores its own bottom padding, so a ruled
  panel is `<CardHeader className="border-b border-border-subtle">` with no
  per-site `pb-*`. `CardFooter` does the same for `border-t`.
- `CardTitle` renders an `h3` — the one deviation from upstream, because a
  Rome panel is a titled section and the pages it replaces use real headings.
  A card whose heading belongs at another level passes its own heading element
  as a child instead.
- Rome's scale, not upstream's: 16px inset, 4px title/description gap,
  `rounded-lg`, and `surface` tokens rather than `card` (only `--surface` is
  declared by every theme block; `--card` is a host-local alias).
- Card is for *static section surfaces*. A selectable option in a picking flow
  is a different concept (the dashboard's `Tile`), not a Card variant.

### `Spinner`

The one loading indicator, so a wait reads the same on every surface.

```tsx
import { Spinner } from "@rome-os/ui/spinner";

<Button size="sm" disabled={installing}>
  {installing ? <Spinner size="sm" /> : <Download />}
  Install
</Button>;
```

- Two sizes, `sm` and `md` (default), matching the icon slot of the `sm` / `md`
  control step — a spinner inside a `sm` Button is the same 14px as the glyph it
  replaces, so swapping one in doesn't move the button's edges.
- No color prop. The glyph strokes in `currentColor`, so it takes the tone of
  whatever it sits in — a destructive button, a muted empty state.
- `role="status"` with a visually-hidden name, `"Loading"` by default and
  overridable with `label` when the wait deserves a better description
  (`label="Installing app"`).
- Under `prefers-reduced-motion` the spin slows rather than stopping: a frozen
  glyph reads as a static icon, which is a worse answer than a calmer one.
- **`Button` has no `loading` prop, deliberately.** Composition already covers
  it — `disabled={busy}` is an attribute the caller passes anyway, and the size
  match above keeps the width stable — so a prop would only add a second way to
  say the same thing.

### `Timestamp`

An instant rendered inline as text, in the zone the user configured rather
than the one the browser happens to be in.

```tsx
import { Timestamp, TimestampProvider } from "@rome-os/ui/timestamp";

// Once, at the host's root, with the zone the user configured.
<TimestampProvider timeZone={guardianTimezone}>
  <App />
</TimestampProvider>;

// Anywhere below it.
<Timestamp value={session.createdAt} />; // "3 minutes ago", and it keeps counting
<Timestamp value={run.finishedAt} format="datetime" />; // "Sep 3, 2026, 3:04 PM"
```

- `value` is anything `new Date()` accepts, or nothing. Empty or unparseable
  renders `fallback` (an em dash by default), so a nullable API field needs no
  guard at the call site.
- `format` is `relative` (the default), `time`, `date`, `datetime`, `full`, or
  an `Intl.DateTimeFormatOptions` object for a layout the presets do not cover.
- `relative` is live. The element re-renders at the moment its wording changes
  and not before: at the minute mark, then once a minute, hourly past an hour,
  and at local midnight once the label is a calendar day. Under a day the
  wording is elapsed time, rounded to the nearest unit; from a day up it is
  calendar days in the zone, so "yesterday" means the previous local date
  whatever the hour.
- Zone and locale resolve prop first, then provider, then the browser. A zone
  the runtime cannot resolve falls back to the browser's. `useTimestampSettings()`
  returns the resolved pair for anything else on the page that formats a date,
  so an axis label agrees with the timestamps beside it.
- Renders a `<time dateTime="…">`, and every layout but `full` carries the
  `full` rendering as its `title`, so hovering a relative or a clock-only label
  shows the exact moment. Pass `title` to replace that.
- `formatTimestamp(value, { format, timeZone, locale, now })` is the same
  rendering as a plain string, for tests and code outside React.

### `Calendar`

The date-grid composite for picking one date or a range. It wraps
`react-day-picker` with Rome's control, radius, and typography treatment.

```tsx
import { Calendar } from "@rome-os/ui/calendar";

<Calendar mode="single" selected={date} onSelect={setDate} />;
```

- Install `react-day-picker` in every package that imports this subpath. It is
  an optional peer, so `pnpm add @rome-os/ui` does not install it.
- `Calendar` and `CalendarDayButton` are subpath-only exports. Keeping them out
  of the barrel lets a consumer import `Button` without the optional peer.
- The root, layout containers, labels, and controls follow the anatomy in
  [`component-roles.md`](../../docs/ui/component-roles.md#composites).

### `Toaster`

The themed Sonner host. Mount it once near the root of each host that uses
toasts.

```bash
pnpm add sonner
```

```tsx
import { Toaster } from "@rome-os/ui/sonner";

<Toaster position="top-right" />;
```

- `sonner` is an optional peer, so consumers that skip this subpath do not
  install it.
- Toast surfaces read `--surface-elevated`, `--foreground`, and `--border` from
  the host. They follow theme changes without a concrete color in the wrapper.
- Rome opts out of Sonner's painted defaults and owns the visual layer through
  Tailwind classes. Consumer `classNames` therefore follow the kit's normal
  last-class-wins override contract without `!important` color utilities.
- Sonner's `theme` and `richColors` paint modes are intentionally excluded from
  the wrapper's props; semantic Rome tokens provide theme-aware colors instead.
- The subpath still carries Sonner's structural stylesheet into the consumer
  bundle for positioning, stacking, swiping, and motion. App bundles therefore
  include those mechanics inside their Shadow DOM.

### `Markdown`

The one prose renderer, so agent output reads the same in the dashboard, in a
first-party app, and in an app someone scaffolded this morning. Built on
[Streamdown](https://streamdown.ai) — a streaming-safe Markdown renderer that
handles a half-written fence mid-token, which is what a live agent turn is —
with Shiki syntax highlighting, KaTeX math, and Mermaid diagrams.

```tsx
import { Markdown } from "@rome-os/ui/markdown";

<Markdown compact>{turn.text}</Markdown>;
```

```css
/* the host's CSS entrypoint, alongside @rome-os/ui/styles.css */
@import "@rome-os/ui/markdown.css";
```

- **Both imports are required.** The stylesheet is deliberately outside
  `styles.css`: Streamdown + KaTeX are hundreds of kilobytes of CSS, and a
  surface that renders no prose shouldn't carry them. An app bundle mounted in
  a Shadow DOM needs the import in its *own* stylesheet — the host document's
  copy does not cross the shadow boundary.
- **Install the peers.** `streamdown`, `@streamdown/code`, `@streamdown/math`,
  `@streamdown/mermaid`, and `katex` are optional peers, so `pnpm add
  @rome-os/ui` alone does not pull them; add them where you import this.
- **Theme comes from the host, like every other kit component.** The prose
  paints from inherited semantic tokens, so it follows the live theme and its
  `.dark` half in a shadow root with nothing injected. Mermaid is the exception
  — its color parser cannot consume OKLCH — so a host on OKLCH primitives
  passes explicit sRGB values through the `theme` prop.
- `compact` rebinds Markdown's own typography and rhythm tokens to their dense
  values. The rendered semantic roles do not change, and hosts use `className`
  for color or layout rather than substituting a generic typography role.
- `preserveSoftBreaks` keeps single newlines inside a paragraph, for surfaces
  where the author's line breaks are meaningful.
- Links are safe by construction: only genuinely cross-origin `href`s get
  `target="_blank"` + `rel="noopener noreferrer"`. A host that routes in-app
  hrefs through its own router passes `linkComponent`.

## Utilities

- `cn(...inputs)` — `clsx` + `tailwind-merge`. Kit components compose their
  variants through it, and consumers use it to override those variants from the
  outside.

## Tier model

Not every component belongs in the kit. Three tiers:

| Tier | Where it lives | What qualifies |
| --- | --- | --- |
| **Kit (public)** | `@rome-os/ui` | The curated set that apps and the dashboard both need and that reads the same in both — controls, the floating family, containers. |
| **Dashboard-private** | `packages/web/src/components` | Components coupled to dashboard data, routing, or chrome. They stay put; the dashboard may keep thin shims that re-export kit components under their old paths. |
| **On-demand (v2)** | promoted into the kit later | Heavier or less-settled surfaces (pickers). They move in when a second consumer proves the need, not before — as [`Markdown`](#markdown) did, arriving with its libraries as optional peers so only the surfaces that render prose pay for them. |

## Styling contract

The kit ships the constant geometry and typography values, semantic token
vocabulary, variants, and base-layer defaults through `@rome-os/ui/styles.css`.
The host owns the theme-specific color and shadow values. A host can therefore
restyle every kit component by changing its theme custom properties, with no
fork of the kit.

The two halves reach a shadow-mounted app by different routes. The kit declares
its constants on `:root, :host`, so an app that imports `styles.css` carries
them in its own bundle and resolves them inside the shadow root. The host's
theme values are inherited custom properties, and inheritance crosses the shadow
boundary on its own.

Only that second half is a promise. Inheritance cannot be narrowed, so an app
also reaches every other name its host declares, including names the host never
meant to expose. An app that reads one renders correctly against that host and
breaks against any other. Import `styles.css` and the constants come with it. An
app that ships no kit stylesheet declares the few constants it uses itself. The
layer rules behind this, and the test that enforces it in this repo, are in
[`docs/design-system.md`](../../docs/design-system.md#rules-that-keep-the-two-layers-sound).

## Consumers

- `packages/web` — the Rome dashboard.
- `rome_apps/*` — first-party apps, through their web bundles.
- Scaffolded external apps — via the app template.

Explicit non-goals: `packages/desktop-base-web` and the
mobile app. They are not on this design system and pulling them in would fix the
kit's API to surfaces it does not serve.

## Dependency policy

- **Peer dependencies** — `react`, `react-dom` (>= 19), `lucide-react`.
- **Dependencies** — small, universal, and safe to duplicate: `clsx`,
  `tailwind-merge`, `class-variance-authority`, and the Radix primitives the
  components are built on. The floating family's Radix packages are pinned to
  exact versions and bumped together: they pin `@radix-ui/react-dismissable-layer`
  exactly, and two copies of that package fight over
  `document.body.style.pointerEvents`.
- **Never a dependency** — heavy tails such as `streamdown` + its
  code/math/mermaid plugins, `katex`, `@dnd-kit/*`, `react-day-picker`, `cmdk`,
  and `sonner`. Components that need them arrive as subpath exports with the
  library declared as an *optional* peer, so an app that imports a button never
  pays for a calendar. [`Calendar`](#calendar), [`Command`](#command), and
  [`Markdown`](#markdown) are the worked examples. All use subpath-only exports
  and optional peers. Markdown also has its own opt-in stylesheet.

## Releasing

Published to npm as `@rome-os/ui` by release-please, on the same rail as
`@rome-os/app-runtime` and `@rome-os/app-web-sdk`. Commits touching this package
must be Conventional (`feat:` / `fix:` / `feat!:`) — see
[`docs/releases.md`](../../docs/releases.md).
