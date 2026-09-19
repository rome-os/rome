---
name: Rome
description: The agentic OS for humans and agents.
colors:
  # Ember light, the default theme. Ash and Slate remap every role below to
  # their own palettes; the mappings live in packages/web/src/lib/themes.ts.
  coral-ember: "#d86f4c"
  deep-ember: "#c2410c"
  ember-flare: "#e55a22"
  linen-canvas: "#f4f3ef"
  chat-canvas: "#f4f3ef"
  app-canvas: "#fdfcf9"
  warm-paper: "#fdfcf9"
  paper-white: "#ffffff"
  recessed-linen: "#efe9e1"
  pressed-linen: "#eae6df"
  ink: "#1a130f"
  muted-ink: "#7a6857"
  subtle-ink: "#b0a294"
  hairline: "#ece6de"
  hairline-strong: "#e0d8cd"
  scrim: "color-mix(in srgb, #1a130f 45%, transparent)"
  signal-red: "oklch(0.58 0.245 27)"
  red-tint: "oklch(0.97 0.04 27)"
  red-ink: "oklch(0.45 0.18 27)"
  red-edge: "oklch(0.86 0.08 27)"
  moss: "#5b7a4a"
  moss-tint: "#e4ead5"
  moss-ink: "#44603a"
  moss-edge: "#c5d2b5"
  amber: "oklch(0.78 0.15 80)"
  amber-tint: "oklch(0.97 0.05 80)"
  amber-ink: "oklch(0.45 0.11 80)"
  amber-edge: "oklch(0.86 0.09 80)"
  ember-tint: "#ffead9"
  ember-ink: "#b0421a"
  ember-edge: "#fbcda6"
typography:
  display:
    fontFamily: "Funnel Sans, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans CJK SC, Source Han Sans SC, sans-serif, Apple Color Emoji, Segoe UI Emoji, Segoe UI Symbol, Noto Color Emoji"
    fontSize: "1.875rem"
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: "0"
  title:
    fontFamily: "Funnel Sans, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans CJK SC, Source Han Sans SC, sans-serif, Apple Color Emoji, Segoe UI Emoji, Segoe UI Symbol, Noto Color Emoji"
    fontSize: "1.125rem"
    fontWeight: 500
    lineHeight: 1.3333
    letterSpacing: "0"
  section:
    fontFamily: "Funnel Sans, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans CJK SC, Source Han Sans SC, sans-serif, Apple Color Emoji, Segoe UI Emoji, Segoe UI Symbol, Noto Color Emoji"
    fontSize: "0.9375rem"
    fontWeight: 500
    lineHeight: 1.3333
    letterSpacing: "0"
  composer:
    fontFamily: "Funnel Sans, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans CJK SC, Source Han Sans SC, sans-serif, Apple Color Emoji, Segoe UI Emoji, Segoe UI Symbol, Noto Color Emoji"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.25
    letterSpacing: "0"
  ui:
    fontFamily: "Funnel Sans, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans CJK SC, Source Han Sans SC, sans-serif, Apple Color Emoji, Segoe UI Emoji, Segoe UI Symbol, Noto Color Emoji"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.4286
    letterSpacing: "0"
  badge:
    fontFamily: "Funnel Sans, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans CJK SC, Source Han Sans SC, sans-serif, Apple Color Emoji, Segoe UI Emoji, Segoe UI Symbol, Noto Color Emoji"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.2308
    letterSpacing: "0"
  aux:
    fontFamily: "Funnel Sans, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans CJK SC, Source Han Sans SC, sans-serif, Apple Color Emoji, Segoe UI Emoji, Segoe UI Symbol, Noto Color Emoji"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.2308
    letterSpacing: "0"
  # Family-only entries. `font-serif` and `font-mono` compose with whichever
  # role the text already carries and define no size of their own.
  serif:
    fontFamily: "Petrona, Cormorant Garamond, Times New Roman, serif"
  mono:
    fontFamily: "IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace"
rounded:
  "4": "4px"
  "8": "8px"
  "12": "12px"
  "16": "16px"
  full: "9999px"
  control-sm: "8px"
  control-md: "10px"
  control-lg: "12px"
spacing:
  "0": "0"
  "1": "0.25rem"
  "2": "0.5rem"
  "3": "0.75rem"
  "4": "1rem"
  "5": "1.25rem"
  "6": "1.5rem"
  "7": "1.75rem"
  "8": "2rem"
  "9": "2.25rem"
  "10": "2.5rem"
  "12": "3rem"
  "16": "4rem"
  "20": "5rem"
  "24": "6rem"
components:
  button-primary:
    backgroundColor: "{colors.coral-ember}"
    textColor: "{colors.paper-white}"
    typography: "{typography.ui}"
    rounded: "{rounded.control-md}"
    padding: "0 14px"
    height: "32px"
  # No button-primary-hover entry: the kit's hover is the primary fill at 80%
  # alpha, which the component schema cannot express. The sidecar carries it.
  button-outline:
    backgroundColor: "{colors.linen-canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.ui}"
    rounded: "{rounded.control-md}"
    padding: "0 14px"
    height: "32px"
  button-outline-hover:
    backgroundColor: "{colors.recessed-linen}"
    textColor: "{colors.ink}"
  button-ghost:
    textColor: "{colors.ink}"
    typography: "{typography.ui}"
    rounded: "{rounded.control-md}"
    padding: "0 14px"
    height: "32px"
  button-ghost-hover:
    backgroundColor: "{colors.recessed-linen}"
    textColor: "{colors.ink}"
  button-destructive:
    textColor: "{colors.signal-red}"
    typography: "{typography.ui}"
    rounded: "{rounded.control-md}"
    padding: "0 14px"
    height: "32px"
  button-sm:
    typography: "{typography.ui}"
    rounded: "{rounded.control-sm}"
    padding: "0 10px"
    height: "28px"
  button-lg-icon:
    rounded: "{rounded.control-lg}"
    size: "44px"
  input:
    textColor: "{colors.ink}"
    typography: "{typography.ui}"
    rounded: "{rounded.control-md}"
    padding: "0 12px"
    height: "32px"
  textarea:
    textColor: "{colors.ink}"
    typography: "{typography.ui}"
    rounded: "{rounded.control-md}"
    padding: "8px 12px"
  badge:
    backgroundColor: "{colors.recessed-linen}"
    textColor: "{colors.ink}"
    typography: "{typography.badge}"
    rounded: "{rounded.full}"
    padding: "0 9px"
    height: "22px"
  badge-warning:
    backgroundColor: "{colors.amber-tint}"
    textColor: "{colors.amber-ink}"
    typography: "{typography.badge}"
    rounded: "{rounded.full}"
    padding: "0 9px"
    height: "22px"
  badge-success:
    backgroundColor: "{colors.moss-tint}"
    textColor: "{colors.moss-ink}"
    typography: "{typography.badge}"
    rounded: "{rounded.full}"
    padding: "0 9px"
    height: "22px"
  badge-destructive:
    backgroundColor: "{colors.red-tint}"
    textColor: "{colors.red-ink}"
    typography: "{typography.badge}"
    rounded: "{rounded.full}"
    padding: "0 9px"
    height: "22px"
  badge-info:
    backgroundColor: "{colors.ember-tint}"
    textColor: "{colors.ember-ink}"
    typography: "{typography.badge}"
    rounded: "{rounded.full}"
    padding: "0 9px"
    height: "22px"
  chip:
    backgroundColor: "{colors.warm-paper}"
    textColor: "{colors.ink}"
    typography: "{typography.badge}"
    rounded: "{rounded.full}"
    padding: "4px 12px"
  chip-selected:
    backgroundColor: "{colors.coral-ember}"
    textColor: "{colors.paper-white}"
    typography: "{typography.badge}"
    rounded: "{rounded.full}"
    padding: "4px 12px"
  card:
    backgroundColor: "{colors.warm-paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.12}"
    padding: "16px"
  tile:
    backgroundColor: "{colors.warm-paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.8}"
    padding: "12px"
  alert:
    backgroundColor: "{colors.warm-paper}"
    textColor: "{colors.ink}"
    typography: "{typography.ui}"
    rounded: "{rounded.8}"
    padding: "12px 16px"
  segmented-track:
    backgroundColor: "{colors.recessed-linen}"
    rounded: "{rounded.control-md}"
    padding: "4px"
    height: "32px"
  segmented-checked:
    backgroundColor: "{colors.linen-canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.ui}"
    rounded: "{rounded.control-sm}"
  menu:
    backgroundColor: "{colors.paper-white}"
    textColor: "{colors.ink}"
    typography: "{typography.ui}"
    rounded: "{rounded.12}"
    padding: "4px"
  menu-item:
    typography: "{typography.ui}"
    rounded: "{rounded.8}"
    padding: "4px 8px"
  tooltip:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.linen-canvas}"
    typography: "{typography.aux}"
    rounded: "{rounded.8}"
    padding: "4px 12px"
  dialog:
    backgroundColor: "{colors.warm-paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.16}"
  sidebar-row:
    textColor: "{colors.ink}"
    typography: "{typography.ui}"
    rounded: "{rounded.8}"
    height: "32px"
  sidebar-row-active:
    backgroundColor: "{colors.warm-paper}"
    textColor: "{colors.ink}"
    typography: "{typography.ui}"
    rounded: "{rounded.8}"
    height: "32px"
---

# Design System: Rome

## Overview

**Creative North Star: "The Quiet Workbench"**

Rome's interface is a calm, well-lit bench where a person and their agents work side by side. Every tool sits in plain view on a warm, low-contrast ground, and one accent marks the thing that needs a hand: an approval waiting, a routine running, a button worth pressing. Nothing performs. Warmth comes from the linen canvas, the ink that stays slightly brown instead of black, and complete sentences, never from decoration.

The system is built for scanning and operating. Type runs in seven fixed roles on a 4px grid, controls come in three heights, and depth is conveyed by tone and hairline borders at rest. Shadows answer to state. Color answers to meaning. Under Ember, Ash, and Slate the same components render without a line of theme-specific code, because every component reads a semantic token and every theme supplies its own value for it. Brand lives in details: the coral on a primary button, a lit ember on an info note, the concentric corners of a control inside a card.

Visual rejections are the ones the codebase already enforces. There is no marketing-style hero inside the app, no gradient or orb, no saturated color as ornament, and no one-off font size, gap, or radius.

**Key Characteristics:**
- Warm neutrals with a single chromatic accent, remapped per theme rather than restyled per component.
- Seven typography roles in one sans, with Petrona reserved for reading surfaces and IBM Plex Mono for code and identifiers.
- Fixed control scale (28, 32, 44px) with concentric radii (8, 10, 12px).
- Flat at rest. Shadows mark hover, checked state, and floating layers only.
- One focus edge everywhere: a 1px outline in the ring color at 50% alpha, quieter than the 2px solid invalid edge.
- Meaning in tinted chips and alerts, never in the canvas.

## Colors

The palette is a warm neutral ramp with a coral accent and four status hues held in pale tints, so an idle screen reads as paper and ink, and color appears where something has a state.

Rome has three themes, each with a light and a dark half. The frontmatter records Ember light, the default. Ash keeps Ember's ink and accent hue but lightens its surfaces and deepens the interactive coral to `#c05433` so labels clear AA. Slate is achromatic: `oklch(0.985 0 0)` canvas, `oklch(1 0 0)` cards, and an ink-colored `oklch(0.18 0 0)` primary that inverts to near-white in dark mode. Components never see these values. They read semantic tokens such as `--primary`, `--surface`, and `--border`, and the theme supplies the value.

### Primary
- **Coral Ember** (`#d86f4c`): The one interactive accent. Fills the primary button, the checked switch, and the selected filter chip. Alpha-modulated for identity: `primary/5` on a selected card, `primary/15` behind a brand badge, `primary/30` for a selection ring. Also the `brand` token under Ember and Ash, so the logo stays on the same hue as the controls.
- **Deep Ember** (`#c2410c`): The `primary-hover` token under Ember, and `#a63a08` under Ash. The kit's `Button` does not read it. Its hover is the primary fill at 80% alpha, and the token serves surfaces that want a solid darker step, such as the sign-in callback page.
- **Ember Flare** (`#e55a22`): The focus ring under Ember and the Ember `info` mark. A slightly hotter step than the accent so a focused control stands apart from a resting primary button.

### Neutral
- **Linen Canvas** (`#f4f3ef`): The generic dashboard ground, used where no dedicated context canvas applies.
- **Linen Chat Canvas** (`#f4f3ef`): The ground behind chat prose and its composer. Kept softly tinted for long-form reading.
- **Warm App Canvas** (`#fdfcf9`): The brighter ground behind compact app UI. It may share a fill with a card, whose border then carries the boundary.
- **Warm Paper** (`#fdfcf9`): A raised card, panel, or table row on the canvas. Dialogs and sheets use it too.
- **Paper White** (`#ffffff`): The highest layer, for popovers, menus, and toasts.
- **Recessed Linen** (`#efe9e1`): A region recessed inside a card: a well, a code block, a table header, the segmented control track, and the `muted` fill behind ghost-button hover.
- **Pressed Linen** (`#eae6df`): Hover and active fill of a row or list item, and the `secondary` and `accent` fills.
- **Ink** (`#1a130f`): Body and control text. Warm, not black.
- **Muted Ink** (`#7a6857`): Descriptions, placeholders, table headers, and annotations. Sits at 5.2:1 on Warm Paper. A lighter step drops card and dialog descriptions under AA.
- **Subtle Ink** (`#b0a294`): Tertiary text, archived items, and inactive glyphs. Below AA by design. Never carries a fact the reader needs.
- **Hairline** (`#ece6de`): The default border and the input edge.
- **Hairline Strong** (`#e0d8cd`): Field hover edge, tile borders, and unselected chip borders.
- **Scrim**: A 45% ink over the page, the `overlay` token. The alpha is baked in, so it is used at full opacity. Sheets and the mobile backdrop paint it. `Dialog` paints a 35% `foreground` wash with a small backdrop blur instead, a divergence this file records rather than resolves.

### Status
- **Signal Red** (`oklch(0.58 0.245 27)`) with Red Tint, Red Ink, and Red Edge: The `destructive` family. The destructive button is a red tint at 10% with red text, not a solid red fill.
- **Moss** (`#5b7a4a`) with Moss Tint, Moss Ink, and Moss Edge: The `success` family. Ember and Ash use a warm moss whose pale end sits comfortably on linen. Slate uses a cool green at hue 150.
- **Amber** (`oklch(0.78 0.15 80)`) with Amber Tint, Amber Ink, and Amber Edge: The `warning` family and the "waiting for approval" state.
- **Ember Tint** (`#ffead9`), **Ember Ink** (`#b0421a`), **Ember Edge** (`#fbcda6`): The `info` family under Ember and Ash, which have no blue in play. Slate maps `info` to blue at hue 250.

### Named Rules
**The One Ember Rule.** A screen at rest carries one chromatic accent, `primary`, and it marks what waits on the guardian or what the guardian can press. Status hues live inside tinted chips and alerts. The canvas, the cards, and the type stay neutral.

**The Semantic-Only Rule.** A component names a semantic token (`bg-primary`, `text-muted-foreground`, `border-border`). It never names a primitive (`--neutral-500`), a raw color, or a per-theme override. Theming and dark mode both ride on this indirection.

**The Tinted-Not-Solid Rule.** Status is a pale tint with a deep ink of the same hue (`success-bg` with `success-fg`), and a hairline `*-border` when it needs an edge. Solid status fills belong only to a dot, a bar, or the marker on a switch.

## Typography

**Display and Body Font:** Funnel Sans (with system sans fallbacks, then PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans CJK SC, and Source Han Sans SC for Simplified Chinese)
**Reading Font:** Petrona (with Cormorant Garamond, Times New Roman)
**Mono Font:** IBM Plex Mono (with ui-monospace, SFMono-Regular, Menlo)

**Character:** One humanist sans does almost all the work, and hierarchy comes from weight and position rather than size jumps. Petrona is present in the kit for prose that is read rather than operated, such as chat blocks and the type specimen, and the dashboard uses it sparingly. Plex Mono sets identifiers, timestamps in columns, and code.

### Hierarchy
Every text run takes exactly one of seven roles. A role sets size, line height, letter spacing, and weight together, and each line box lands on the 4px grid.

- **Display** (400, 30px/36px): The one hero moment on a screen, such as the home greeting. Never a second element on the same screen.
- **Title** (500, 18px/24px): The heading a page or dialog carries once, at the top.
- **Section** (500, 15px/20px): The heading of a section, card, or panel inside a surface.
- **Body** (400, 16px/20px): Prose someone reads as content: chat messages and paragraphs. Also the smallest size mobile Safari does not zoom on focus.
- **UI** (400, 14px/20px): Controls: sidebar rows, menu items, buttons, tabs, fields and their labels, and both rows of a compact alert.
- **Badge** (500, 13px/16px): Text inside a compact labeled container: chips, tags, status pills, counters.
- **Aux** (400, 13px/16px): Metadata that annotates other content: timestamps, uncontained counts, group headers, captions. Columns of times or counts add `tabular-nums`.

The font size scale has nine steps (13, 14, 15, 16, 18, 20, 22, 24, 30px). The seven roles read 13, 14, 15, 16, 18, and 30. Steps 20, 22, and 24 back the Markdown heading tokens, not a dashboard role.

### Named Rules
**The Seven Roles Rule.** Text reads `text-display`, `text-title`, `text-section`, `text-composer`, `text-ui`, `text-badge`, or `text-aux`. A one-off size or line height is unfinished migration, not a pattern.

**The Weight, Not Size Rule.** Emphasis comes from color, weight, or position within the same role. A label is never bumped one size to read as important, and an active row leads by fill, not by scale. The CJK system fallbacks ship no 500 face, so the weight on Title, Section, and Badge is Latin-only. Hierarchy on a bilingual surface also comes from size through a different role, ink, position, or container geometry.

## Layout

The grid is 4px. Spacing comes from one scale of fifteen steps (0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 48, 64, 80, 96px) and every gap, padding, and inset is a step. A value between steps never enters as a one-off.

The guardian shell is a sidebar plus a content column. On desktop (768px and up) the sidebar is sticky and 256px wide, collapsing to a 64px rail. Below 768px it becomes a fixed slide-over, and a 48px mobile header (plus the safe-area inset) sits at the top of the content column. The file browser switches from two panes to a compact single pane below a 1024px container width. Apps mount inside the content column in a Shadow DOM and inherit the theme layer.

Density is operational but not cramped. Cards carry 16px inner padding, tiles 12px, menu items 4px by 8px. Controls sit on three heights: 28px (`sm`), 32px (`md`, the default), and 44px (`lg`, square icon buttons only, for touch). Badges are 22px. Avatars are 24, 32, and 40px. When a control shares a row with loose text, the row takes the taller of the two, and the air around the text inside a control is never more than the text's own line box.

Touch targets on compact surfaces reach 44 to 48px through padding or a `::after` hit area, not by enlarging the visible control. Hover-only disclosure is never the only path to an action.

## Elevation & Depth

Rome is flat at rest. Two context canvases sit beneath three content depths: a raised card (`surface`), a recessed region inside a card (`surface-muted`), and a floating layer (`surface-elevated`). Chat uses `chat-canvas`; compact app UI uses the brighter `app-canvas`; dashboard pages without a dedicated context use `background`. A canvas and card may share a fill, so the card's hairline border must still carry its boundary. In dark mode the distinct steps lighten as they rise, which is why depth names describe position rather than lightness.

Shadows appear as a response to state or to floating. A card takes `shadow-4` on hover. A checked segment and the active sidebar row take `shadow-1`. Menus, popovers, and selects take `shadow-4` with a 10% ink ring, and a submenu that opens beside a menu takes `shadow-10`. Dialogs and sheets take `shadow-25` over their backdrop. Nothing else in the kit casts. A dashboard page that paints `shadow-1` on a resting card is unfinished migration, not a pattern.

### Shadow Vocabulary
- **Rest lift** (`box-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)`): `shadow-1`, on the checked segment of a segmented control and the active chat row.
- **Hover lift** (`box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)`): `shadow-4`, on card hover, menus, popovers, selects, and toasts.
- **Submenu** (`box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)`): `shadow-10`, on a submenu that opens beside a menu, and on the dashboard's floating composer chrome.
- **Modal** (`box-shadow: 0 25px 50px -12px rgb(0 0 0 / 0.25)`): `shadow-25`, on dialogs and sheets.

Dark mode deepens the ink (alpha 0.4 to 0.7) and widens the blur, because a 10% black cast vanishes on a near-black canvas. The values are per theme in `themes.ts`, and every theme carries all four steps in both halves.

### Named Rules
**The State Shadow Rule.** A surface at rest has a border and a tone, never a shadow. A shadow says hover, checked, or floating.

**The Achromatic Ink Rule.** Every shadow is black at an alpha. A tinted shadow would fork per theme.

## Shapes

Corners come from one scale (4, 8, 12, 16px) plus a saturation token for fully round (9999px). Neighbors differ by 4px, which is one spacing step, so a box inset by one step from an enclosing corner lands exactly one radius step down and nested corners stay concentric.

Controls take their own three steps, 8, 10, and 12px, matched to their heights (28, 32, 44px), and inputs, buttons, and select triggers on the same size share the same corner. A small button inside a button group squares to 8px so the group reads as one object. Cards are 12px, dialogs 16px, menus and popovers 12px, menu items and tiles 8px, tooltips 8px, and inline code 4px. Badges, chips, switches, and avatars are pills.

Borders are 1px hairlines in `border`. A control that can paint a border declares the width unconditionally and lets a variant change only the color, so nothing shifts on hover. Fields show a hairline edge at rest, `border-strong` on hover, and no fill on light themes. The focus edge is a 1px outline in `ring` at 50% alpha. Filled and ghost controls sit it at offset 0, outside the box. Bordered controls (inputs, textareas, select triggers, outline buttons) inset it 1px onto their own border. The control carries the outline at rest, transparent, so focus changes only the style and the color. Invalid is 2px of solid `destructive`, always louder than focus. A translucent halo never appears.

### Named Rules
**The Concentric Corner Rule.** A corner nested one spacing step inside another corner is one radius step smaller. No arithmetic, no eyeballing.

**The Silent Corner Rule.** A radius never signals a state. A range endpoint may round its outer corners and square the shared seam, but an input never softens on focus.

## Components

Components are precise and restrained. Each one declares its own typography role and reads only semantic tokens, so a call site never sets a type utility, a color, or a per-theme class on it.

### Buttons
- **Shape:** Height 32px, radius 10px, horizontal padding 14px for centered content and 12px for start-aligned content. Small is 28px with 8px radius and 10px padding. Icon-only buttons are square on the same heights, plus a 44px large step with 12px radius.
- **Primary:** Coral Ember fill, white label at weight 500. Hover is the same fill at 80% alpha (`hover:bg-primary/80`), not the `primary-hover` token. Under Ash the fill is the deeper coral and under Slate it is ink.
- **Outline:** Canvas fill, hairline border, ink label. Hover switches to the recessed fill. Dark mode uses a 30% input tint.
- **Ghost:** No fill or border at rest. Hover takes the recessed fill.
- **Secondary:** Pressed Linen fill, ink label. Hover mixes 5% ink into the fill.
- **Destructive:** 10% red tint with Signal Red label. Hover deepens to 20%. Never a solid red fill.
- **Link:** Coral text, underline on hover with a 4px offset.
- **Press:** Every button drops 1px on active. Focus is the shared 1px `ring` outline at 50% alpha, outside the box. Disabled is 50% opacity with pointer events off.

### Badges and Chips
- **Badge:** 22px pill, 9px horizontal padding, `text-badge`. Variants are tinted: default and muted on Recessed Linen, info, success, warning, and destructive on their tint with their ink, brand on 15% coral with coral text, outline on a hairline.
- **Filter chip:** Pill with 12px by 4px padding on Warm Paper with a strong hairline. Selected fills Coral Ember with a white label. An optional count trails in `tabular-nums`, in Subtle Ink when unselected.

### Cards and Tiles
- **Card:** Warm Paper on the canvas, 12px radius, hairline border, 16px padding, 16px gap between header, content, and footer. Title is `text-section`, description is `text-ui` in Muted Ink. No shadow at rest. Interactive cards take `shadow-4` on hover.
- **Tile:** 8px radius, 12px padding, strong hairline border. Hover recesses the fill. A selected tile takes a coral border, a 5% coral fill, and a 1px coral ring.
- **Alert:** 8px radius, 12px by 16px padding, `text-ui` in both rows with the title at weight 600, and a 16px leading icon. Default is Warm Paper with a hairline and a Muted Ink description. Status variants use the tint, ink, and edge of their family and set the description to `foreground`.

### Inputs and Fields
- **Style:** Transparent fill, hairline `input` border, 32px height, 10px radius, 12px start inset, `text-ui`. Placeholder is Muted Ink. A leading glyph sits at the start inset and pushes the text by the glyph width plus 6px.
- **Hover:** Border steps up to Hairline Strong.
- **Focus:** 1px `ring` outline at 50% alpha, inset onto the border. No glow.
- **Error:** 2px solid Signal Red at offset 0.
- **Disabled:** 50% opacity, cursor `not-allowed`, and a 50% input tint.
- **Plain variant:** No border, radius, or fill, for a field already framed by its surface, such as the command palette input.
- **Textarea:** The same recipe with 8px vertical padding, a 64px minimum, and `field-sizing: content`.
- **Select trigger:** Matches the input, with the value clamped to one line and a 16px chevron.

### Segmented Control and Tabs
- **Segmented control:** A 32px Recessed Linen track with 4px inner padding and 10px radius. Segments are 8px-radius items at 60% ink. The checked segment lifts to its context canvas color with `shadow-1` and full ink.
- **Tabs:** Transparent list, 32px tall. Triggers are `text-ui` at 60% ink, full ink on hover and when active. The active trigger draws a 2px ink underline 5px below the label. No fill.
- **Switch:** A pill track that fills coral when checked. The thumb follows its context canvas color, 16px in the default size, 12px in small, with a 1px inset. The hit area extends 12px horizontally and 8px vertically past the track.

### Navigation
- **Sidebar:** Canvas fill with a hairline right border, 256px wide, 64px as a rail. Rows are 32px, 8px radius, `text-ui`. Hover takes `surface-hover`. The current chat is Warm Paper with `shadow-1`. Archived chats read in Subtle Ink. Unread activity is an 8px `info` dot that hides on hover to reveal the row action. Below the pinned entries, a hairline and an aux "Recent" label introduce up to three unpinned apps the guardian built or opened in the last 14 days, most recent first, with a "Show more" row for the rest. The zone is absent when empty. An installed, never-opened app carries the same 8px `info` dot, which on hover gives way to a Pin action. On touch the Pin action is always visible and the dot sits beside it.
- **Mobile header:** 48px plus the safe-area inset, hairline bottom border, hidden from 768px up.
- **Chat search:** `Command+K` on Apple platforms and `Ctrl+K` elsewhere open a command dialog. The trigger stays visible beside the list settings, since a shortcut is never the only path.

### Floating Layers
- **Menu and context menu:** Paper White, 12px radius, 4px padding, `shadow-4` with a 10% ink ring, the same as popovers and selects. A submenu takes `shadow-10`. Items are 8px radius with 4px by 8px padding, and the focused item takes the `accent` fill. Destructive items take a 10% red tint on hover.
- **Tooltip:** Ink fill with canvas-colored `text-aux`, 8px radius, 4px by 12px padding.
- **Dialog:** Warm Paper, 16px radius, hairline border, `shadow-25`, a 5% black ring, over a 35% `foreground` wash with a small backdrop blur. Sheets share the treatment with a left hairline instead of a radius, over the `overlay` scrim.
- **Toast:** Paper White, 8px radius, hairline border, 16px padding, `shadow-4`.
- **Motion:** Floating layers fade and zoom from 95% over 100ms and slide 8px from their trigger side. The mobile sheet rises over 280ms on `cubic-bezier(0.16, 1, 0.3, 1)` with a 200ms backdrop fade. The sidebar slides and resizes over 200ms ease-out. Empty states rise 12px with a blur over 720ms. Every animation is disabled under `prefers-reduced-motion`.

### Empty State
A centered block with a 44px Recessed Linen glyph well (12px radius), a `text-section` title, and a `text-ui` description in Muted Ink. Minimum height 192px.

## Do's and Don'ts

### Do:
- **Do** write `bg-primary`, `text-muted-foreground`, and `border-border`. The theme supplies the value, and every theme and both modes come for free.
- **Do** pick a text role by asking what the text is: a control reads `text-ui`, a chip reads `text-badge`, a timestamp reads `text-aux`.
- **Do** spend `primary` on the one thing a screen needs the guardian to notice or press, and use alpha (`primary/5`, `primary/15`) when the accent marks identity rather than action.
- **Do** put status in a tinted chip or alert: `success-bg` with `success-fg`, and the family's border when it needs an edge.
- **Do** compose the complete focus recipe: `outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50`. The width utility alone renders no outline.
- **Do** take every gap, inset, and radius from a scale step, and let a nested corner sit one step below its parent.
- **Do** give compact surfaces a visible action affordance. Long-press, right-click, hover, and drag are accelerators.

### Don't:
- **Don't** name a primitive (`--neutral-500`) or a raw color inside a component. It compiles, passes tests, and breaks in every other theme. A `dark:` variant is a mode step on a semantic token, as in `dark:bg-input/30`, never a way to reach a raw color, and a component that reads semantic tokens rarely needs one.
- **Don't** add a marketing hero, a gradient, an orb, or saturated color as ornament inside the app.
- **Don't** bump a font size to make something important, or invent a size between steps.
- **Don't** put a shadow on a surface at rest. Shadows mean hover, checked, or floating.
- **Don't** paint a solid status fill behind text, or use `danger`, `brand`, or `accent` where `destructive` or `primary` is the token.
- **Don't** use `bg-black/40` for a scrim. The `overlay` token carries its own alpha.
- **Don't** read a host-only token from inside an app without compiling it. Geometry and typography come from `@rome-os/app-web-sdk/styles`, and only the theme layer crosses the Shadow DOM.
