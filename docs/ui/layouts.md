# Page Layouts

A **page layout** is the skeleton a routed page fills: the regions it stacks and every measurement those regions need — padding, column widths, breakpoints, and which one scrolls. A page fills the regions and writes no `max-w-*`, `space-y-*`, or `p-*` of its own.

The skeleton itself is `Page`, in `packages/ui/src/page.tsx`: a header, then a body, at one padding and one rhythm. What differs between layouts is the body, and that is what the kit ships as `packages/ui/src/layout-*.tsx` — `ListCollection` and its toolbar, `FormRows` and its rows. A layout ships a frame component of its own only when its frame differs from `Page`, which is why neither List nor Form has one.

A page picks its layout by naming the reader's task, never by how the content looks. A table of rows is a List when the reader leaves with one item, and a different layout when the reader works through the rows one by one without leaving.

The catalogue enters one layout at a time, each landing with a dashboard page migrated onto it, so the rule and a page held to it are read together. [List](#list) came first, then [Form](#form).

## The shared frame

`Page` is the frame a routed page renders into. It carries the padding `p-4 sm:p-6 lg:p-8` at full width, centers nothing, and stacks the regions inside it 24px apart. The shell has already raised the column it fills onto a [pane](semantic-token/surfaces.md#surfaces), so `Page` paints nothing and no layout places one. A page that needs a different frame — full-bleed, or centered on both axes — takes a layout that ships one. Every other page takes `Page` directly and stacks its body under the header.

`PageHeader` holds the identity block. `PageHeaderNav` takes a breadcrumb or a back link on its own line, `PageHeading` groups `PageTitle` with `PageDescription`, and `PageActions` sits opposite the heading. `PageTitle` is the one `h1` a page carries. A `Section` inside the page carries an `h2` through `SectionTitle`. The roles come from [typography.md](semantic-token/typography.md), so a layout writes `text-title`, `text-section`, `text-ui`, and `text-aux` and never a raw size.

`PageNav` is the strip of sibling views under the header, one `PageNavLink` per route. It is a `nav` of links rather than a tablist, because each entry is a route change and the view it reveals renders as the page's body, not inside a `TabsContent` — `role="tab"` would point `aria-controls` at ids that do not exist. `active` both paints the underline and sets `aria-current="page"`. The strip belongs to the frame, not to any one layout: a page keeps one `h1` and one header whichever view is showing, and the body under the strip is whatever that view's task calls for.

`Measure` caps content at the reading measure. It sits below the header rather than around it, so the `h1` stays at the same spot across routes. `Page` holds its regions 24px apart, and content inside a block sits 12px to 16px apart.

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

| Region | Component | Holds | From |
|---|---|---|---|
| Frame | `Page` | The padding and the 24px rhythm | the skeleton |
| Header | `PageHeader` | Title, description, and the action that creates an item | the skeleton |
| Toolbar | `ListToolbar` | Search, filters, and sort, in one tab stop | List |
| Collection | `ListCollection` | A `Table`, or a `ListGrid` of cards | List |
| Footer | `ListFooter` | Pagination, a count, or a load-more control | List |

`ListCollection` scrolls sideways rather than widening the page, so a wide table leaves the header in place. `ListGrid` runs one column, two from `sm`, and three from `xl`.

### Toolbar

Search leads the row and grows into the space the other controls leave. More than two filters collapse into one Filter control that opens the set, with an active-filters row beneath the toolbar naming what is set, each entry removable. The row exists only while something is set. Sort lives on the collection's column headers when the collection is a table, and appears as a control only for a card list, which has no headers to carry it. An action that does not narrow the collection — refresh, export — sits at the trailing end as an icon button, so the reading order of the row is search, then narrowing, then everything else.

The split the row reads by is the same one the header takes: a control that changes which rows are shown belongs in the toolbar, and a control that scopes the whole page belongs beside the title.

[`/sessions/all`](../../packages/web/src/pages/SessionsPage.tsx) is the reference for a table, and [`/apps`](../../packages/web/src/pages/AppsIndexPage.tsx) for a grid the reader searches rather than filters: one control narrows it, so the row holds search alone.

## Form

Used for changing settings and seeing the change took: one column at the reading measure, with save state shown where the change was made. Not used for a one-shot linear flow.

| Region | Component | Holds | From |
|---|---|---|---|
| Frame | `Page` | The padding and the 24px rhythm | the skeleton |
| Header | `PageHeader` | Title and description | the skeleton |
| Rows | `FormRows` | `FormRow` blocks, one setting each | Form |

Form contributes one region. A page that already owns a header stacks `FormRows` under what it has, because there is no Form frame to get in the way. [`/settings/appearance`](../../packages/web/src/pages/SettingsTabPage.tsx) is that page: one `Page`, one `PageHeader`, a `PageNav` its six tabs share, and then the body of whichever tab is showing.

Settings the reader returns to and changes one at a time take rows. A form filled top to bottom and submitted reads as stacked fields instead, and that body is not in the kit yet: it enters with the first data-entry page that needs it.

`FormRows` caps at the reading measure and the frame stays full width, so the `h1` sits where it does on every other route. The surface divides its rows with a hairline, so a set of settings reads as one block rather than as separate cards.

A `FormRow` holds an optional `FormRowIcon`, a `FormRowHeading` carrying `FormRowLabel` and an optional `FormRowDescription`, and a `FormRowControl` at the end. The icon column opens only on the rows that carry one, so a set of rows without icons keeps its labels at the inset. `FormRowLabel` renders a `label` when given `htmlFor` and plain text otherwise, because a `for` aimed at nothing names nothing. A row is one line at every width: the heading wraps its own text rather than pushing the control onto a second line, since a row that stacks on a narrow viewport stops reading as a row exactly where the list is longest. A row floors at 64px, the box-size step above a `md` control inside the row's 12px insets, so a row carrying a control and a row carrying only text are the same height.


## Preview

`/dev/layouts` renders each layout against fake content, with the theme and mode switches the [component gallery](../design-system.md#component-gallery) uses. Reach for it when changing a layout, and check the narrow-viewport form as well as the wide one. Each specimen carries a line naming what to try, such as the arrow keys inside a toolbar.
