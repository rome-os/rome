# Page Layouts

A **page layout** is the frame a routed page renders into. It fixes the page as a set of named slots and owns every measurement those slots need: padding, column widths, breakpoints, and which region scrolls. A page fills the slots and writes no `max-w-*`, `space-y-*`, or `p-*` of its own. The kit ships each one as `packages/ui/src/layout-*.tsx`, on the shared frame in `packages/ui/src/page.tsx`.

A page picks its layout by naming the reader's task, never by how the content looks. A table of rows is a List when the reader leaves with one item, and a different layout when the reader works through the rows one by one without leaving.

The catalogue enters one layout at a time, each landing with a dashboard page migrated onto it, so the rule and a page held to it are read together. [List](#list) is the first.

## The shared frame

A layout renders inside `Page`, which carries the padding `p-4 sm:p-6 lg:p-8` at full width and centers nothing.

`PageHeader` holds the identity block. `PageHeaderNav` takes a breadcrumb or a back link on its own line, `PageHeading` groups `PageTitle` with `PageDescription`, and `PageActions` sits opposite the heading. `PageTitle` is the one `h1` a page carries. A `Section` inside the page carries an `h2` through `SectionTitle`. The roles come from [typography.md](semantic-token/typography.md), so a layout writes `text-title`, `text-section`, `text-ui`, and `text-aux` and never a raw size.

`Measure` caps content at the reading measure. It sits below the header rather than around it, so the `h1` stays at the same spot across routes. Blocks inside a page sit 24px apart and content inside a block sits 12px to 16px apart.

No layout renders `main`. The dashboard shell owns that landmark, and a second one nested inside it breaks landmark navigation. Layouts render `div`, `section`, `header`, `aside`, and `nav`.

An empty, loading, or error state is slot content, not a layout concern. Pass an [`EmptyState`](../../packages/ui/src/empty-state.tsx) into the slot that would otherwise hold the collection. No layout takes an `isLoading` or `isEmpty` prop.

### View switch

A page that offers sibling views of one collection puts the `SegmentedControl` alone in `PageActions` and takes `PageHeader align="end"`, so the switch sits opposite the title with its bottom edge on the title's line box. Every control that acts on the collection rather than choosing the view — a time range, a refresh — belongs in the toolbar instead, at the end of the row.

The split is what the arrangement reads by: the header carries what the page *is*, and the toolbar carries what the reader does to it. `align="end"` is for exactly this header, where the actions are one control on the title's row. A header whose actions may wrap keeps the default `start`. [`/people/latest`](../../packages/web/src/pages/PeoplePage.tsx) is the reference.

## What the slots are built from

Structure is plain elements. Every slot a reader operates is a kit primitive, so the behaviour is the primitive's rather than each layout's.

A toolbar slot is `Toolbar`, on Radix Toolbar. It takes one tab stop for the whole row, and the arrow keys move between the controls inside it. Each control stays a kit `Button`, `IconButton`, or `Toggle`, passed through `ToolbarButton asChild` so it keeps its own step and focus edge. A text field inside a toolbar keeps its own tab stop, which is what typing into one needs. Every toolbar slot requires an `aria-label`.

## List

Used for a collection the reader scans or searches to find one item and then leaves. Not used when the reader processes items one by one while keeping the list in view.

| Slot | Component | Holds |
|---|---|---|
| Header | `PageHeader` | Title, description, and the action that creates an item |
| Toolbar | `ListToolbar` | Search, filters, and sort, in one tab stop |
| Collection | `ListCollection` | A `Table`, or a `ListGrid` of cards |
| Footer | `ListFooter` | Pagination, a count, or a load-more control |

`ListCollection` scrolls sideways rather than widening the page, so a wide table leaves the header in place. `ListGrid` runs one column, two from `sm`, and three from `xl`.

### Toolbar

Search leads the row and grows into the space the other controls leave. More than two filters collapse into one Filter control that opens the set, with an active-filters row beneath the toolbar naming what is set, each entry removable. The row exists only while something is set. Sort lives on the collection's column headers when the collection is a table, and appears as a control only for a card list, which has no headers to carry it. An action that does not narrow the collection — refresh, export — sits at the trailing end as an icon button, so the reading order of the row is search, then narrowing, then everything else.

The split the row reads by is the same one the header takes: a control that changes which rows are shown belongs in the toolbar, and a control that scopes the whole page belongs beside the title.

[`/sessions/all`](../../packages/web/src/pages/SessionsPage.tsx) is the reference for a table, and [`/apps`](../../packages/web/src/pages/AppsIndexPage.tsx) for a grid the reader searches rather than filters: one control narrows it, so the row holds search alone.

## Preview

`/dev/layouts` renders each layout against fake content, with the theme and mode switches the [component gallery](../design-system.md#component-gallery) uses. Reach for it when changing a layout, and check the narrow-viewport form as well as the wide one. Each specimen carries a line naming what to try, such as the arrow keys inside a toolbar.
