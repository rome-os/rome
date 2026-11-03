# Vendored rome-core trace UI

The Showcases app reproduces the rome chat page's agent-trace UI **without
depending on rome-core**. The presentational trace components are copied from
rome-core to keep updates mechanical. Their `import` lines target standalone
shims. Off-roster typography utilities map to semantic roles that the app
stylesheet declares.

The app must be distributable to other users' Rome installs and must not import
rome-core packages. When the chat page changes upstream, re-copy the source file.
Then re-apply the documented **import and typography seams**. Keep the remaining
component body aligned with upstream.

## Source of truth (rome-internal)

| Vendored file (`rome-core/`)      | Upstream path (`packages/...`)                                  |
| --------------------------------- | --------------------------------------------------------------- |
| `AgentTrace.tsx`                  | `web/src/components/agent-trace/AgentTrace.tsx`                 |
| `CollapsedTraceSummary.tsx`       | `web/src/components/agent-trace/CollapsedTraceSummary.tsx`      |
| `CollapsibleTraceRow.tsx`         | `web/src/components/agent-trace/CollapsibleTraceRow.tsx`        |
| `TraceRunRow.tsx`                 | `web/src/components/agent-trace/TraceRunRow.tsx`               |
| `MessageRow.tsx`                  | `web/src/components/chat/MessageRow.tsx`                        |
| `trace-format.ts`                 | `web/src/lib/trace-format.ts`                                  |
| `markdown.tsx`                    | `web/src/components/markdown.tsx`                              |
| `MermaidBlock.tsx`                | `web/src/components/chat/entries/MermaidBlock.tsx`             |
| `ThinkingBlock.tsx`               | `web/src/components/chat/entries/ThinkingBlock.tsx`           |
| `TraceJsonView.tsx`               | `web/src/components/chat/entries/TraceJsonView.tsx`            |
| `TracePayload.tsx` (image helpers)| `web/src/components/chat/entries/TracePayload.tsx` (subset; `TraceImageView` drops the zoom wrapper) |
| `../../trace/types.ts` (DTOs)     | `api-types/src/trace-segments.ts` (the trace DTO subset)        |
| `../../trace/build-snapshot.ts`   | rome-core segment builder (server-side grouping logic)          |

> Record the upstream commit SHA you synced from in each file header so the next
> sync has a clean diff base.

## Import seams

Re-apply exactly these import substitutions after recopying a file. Apply the
typography and file-specific seams documented below as well.

| Upstream import                              | Replace with                          |
| -------------------------------------------- | ------------------------------------- |
| `from "react-i18next"`                       | `from "../shims/i18n"`                |
| `from "i18next"` (the `TFunction` type)      | `from "../shims/i18n"`                |
| `from "@radix-ui/react-icons"`               | `from "../shims/icons"`              |
| `from "@/components/ui/tooltip"`             | `from "../shims/tooltip"`            |
| `from "@/hooks/use-theme"`                   | `from "../shims/use-theme"`          |
| `from "@/components/markdown"`               | `from "./markdown"`                  |
| `from "@/components/chat/entries/MermaidBlock"` | `from "./MermaidBlock"`            |
| `from "@rome/api-types/trace-segments"`      | `from "../../../trace/types.js"`     |
| `from "@/lib/utils"` (the `cn` helper)       | `from "../../lib/utils.js"`          |

## Typography seams

The utility-token gate scans this vendored tree because these classes ship in
the app bundle. Upstream utilities that are absent from Rome's typography
roster would compile to no usable rule here, so re-syncs must preserve these
semantic substitutions:

- Badge and count pills use `text-badge`.
- Auxiliary labels, metadata, and structured payload text use `text-aux`.

Do not introduce a local typography name to preserve an upstream class. Use a
role from `packages/ui/src/styles.css`. The host and app bundles then share the
same contract.

### `markdown.tsx` extra seams

`markdown.tsx` renders assistant text exactly like the chat page (react-markdown +
remark-gfm + Tailwind `prose`). Beyond the import table above it has two body
adaptations, both documented in its header:

- `react-router-dom` `Link` → plain `<a>` (the static viewer has no SPA router).

It depends on these packages (all in `package.json`): `react-markdown`,
`remark-gfm`, `beautiful-mermaid` (Mermaid → SVG), and the
`@tailwindcss/typography` plugin (loaded via `@plugin "@tailwindcss/typography";`
in `web/styles.css`). The app's own `web/components/Markdown.tsx` is a thin
`{content}` → `{children}` adapter over this file.

### `MermaidBlock.tsx` / `ThinkingBlock.tsx`

- `MermaidBlock.tsx` renders ` ```mermaid ` fences to SVG via `beautiful-mermaid`.
  Its only seam is `@/hooks/use-theme` → `../shims/use-theme` (a light/dark
  detector). `markdown.tsx`'s `pre` handler routes mermaid fences to it.
- `ThinkingBlock.tsx` renders agent thinking **collapsed by default** with a
  one-line preview that expands on click — used by `web/trace/render.tsx` for
  `thinking` blocks. Seams: i18n (`chat` namespace), icons, and `./markdown`.

## Shims (`shims/`)

- `i18n.ts` — minimal `useTranslation` + frozen copies of the English `activity`
  (`trace.*`) and `chat` (`blocks.*`) namespaces (sources:
  `web/src/i18n/locales/en/{activity,chat}.json`). Re-copy those subtrees when
  strings change.
- `icons.tsx` — re-exports the Radix icon names used upstream
  (`ChevronDownIcon`, `ChevronRightIcon`, `Cross2Icon`, `DownloadIcon`) mapped
  onto `lucide-react` (already an app dependency).
- `tooltip.tsx` — no-op Tooltip primitives; the static viewer needs no floating
  tooltip, so trigger renders its child and content renders nothing.
- `use-theme.ts` — `useTheme()` returning `{ resolved: "light" | "dark" }` by
  detecting a `.dark` ancestor of the shadow host (falling back to the OS
  preference), so Mermaid diagrams match the host theme. Re-checks on class
  mutations.

## What is intentionally NOT vendered

- **`TraceDrawer.tsx`** is NOT vendored verbatim: upstream couples it to the
  chat runtime (it `fetch`es `/api/chat/messages/:id/content`, links to the turn
  feedback API, and renders a live-streaming feedback footer). The Showcases app
  ships its own thin drawer shell (`web/components/ShowcaseTraceDrawer.tsx`) that
  **reuses the vendored `TraceBody`** and feeds it the static, already-imported
  snapshot. When syncing, port any layout/markup changes from upstream
  `TraceDrawer.tsx` into `ShowcaseTraceDrawer.tsx` by hand.
- **Most of `chat/entries/*`** are NOT vendored: they pull in interactive cards
  (approval, ask-user-question, routine-draft), polling, and `@/lib/chat-types`.
  A static showcase has no live interaction, so the app supplies its own
  lightweight `renderInlineBlock` / `renderRunBlocks` (`web/trace/render.tsx`)
  covering only the static block subset (text, thinking, tool step, session-init,
  usage, error). These two functions are injected into the vendored components
  exactly as the chat page injects its own renderers — so the vendored shell is
  unchanged. The two presentational blocks worth reusing — `MermaidBlock` and
  `ThinkingBlock` — **are** vendored (see above).

## Why the Tailwind classes "just work"

The vendored components paint with rome's semantic design tokens
(`bg-surface-muted`, `text-foreground`, `text-subtle-foreground`, `ring-border`,
`text-destructive`, `bg-info-bg`, …). The app's `styles.css` imports
`@rome-os/app-web-sdk/styles`, which registers those exact token names via an
`@theme inline` block and pulls in Tailwind v4. The host theme's token values are
inherited across the Shadow DOM boundary, so the app tracks the live Rome theme
(including dark mode) with no extra work.
