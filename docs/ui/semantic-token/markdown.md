# Markdown Tokens

A semantic token doc for Markdown typography and rhythm. [ui-semantic-tokens.md](../../authoring/ui-semantic-tokens.md) is the rulebook.

| Group | Token roster |
|---|---|
| Body typography | `--markdown-body-font-size`, `--markdown-body-line-height`, `--markdown-body-font-weight`, `--markdown-body-letter-spacing` |
| Heading typography | `--markdown-heading-{1…4}-font-size`, `--markdown-heading-{1…4}-line-height`, `--markdown-heading-floor-font-size`, `--markdown-heading-floor-line-height`, `--markdown-heading-font-weight`, `--markdown-heading-letter-spacing` |
| Block rhythm | `--markdown-block-space-between`, `--markdown-heading-{1…4}-space-before`, `--markdown-heading-{1…4}-space-after`, `--markdown-heading-floor-space-before`, `--markdown-heading-floor-space-after` |
| Lists | `--markdown-list-space-block`, `--markdown-list-item-space-block` |
| Embedded blocks | `--markdown-code-block-space-block`, `--markdown-blockquote-space-block`, `--markdown-table-space-block`, `--markdown-rule-space-block`, `--markdown-media-space-block` |

## Why this name

Markdown names a document grammar, not a dashboard text role. The prefix separates document structure from generic dashboard typography. `[llm]`

## Usage statement

- `--markdown-body-font-size` — Used for Markdown body size. Not used for dashboard copy.
- `--markdown-body-line-height` — Used for Markdown body leading. Not used for control labels.
- `--markdown-body-font-weight` — Used for Markdown body weight. Not used for heading emphasis.
- `--markdown-body-letter-spacing` — Used for Markdown body tracking. Not used for code tracking.
- `--markdown-heading-1-font-size` — Used for Markdown Heading 1 size. Not used for page titles.
- `--markdown-heading-1-line-height` — Used for Markdown Heading 1 leading. Not used for page titles.
- `--markdown-heading-2-font-size` — Used for Markdown Heading 2 size. Not used for dashboard sections.
- `--markdown-heading-2-line-height` — Used for Markdown Heading 2 leading. Not used for dashboard sections.
- `--markdown-heading-3-font-size` — Used for Markdown Heading 3 size. Not used for card headings.
- `--markdown-heading-3-line-height` — Used for Markdown Heading 3 leading. Not used for card headings.
- `--markdown-heading-4-font-size` — Used for Markdown Heading 4 size. Not used for control labels.
- `--markdown-heading-4-line-height` — Used for Markdown Heading 4 leading. Not used for control labels.
- `--markdown-heading-floor-font-size` — Used for Markdown Heading 5 and 6 size. Not used below body size.
- `--markdown-heading-floor-line-height` — Used for Markdown Heading 5 and 6 leading. Not used for body leading.
- `--markdown-heading-font-weight` — Used for every Markdown heading level. Not used for strong text.
- `--markdown-heading-letter-spacing` — Used for every Markdown heading level. Not used for dashboard headings.
- `--markdown-block-space-between` — Used between ordinary Markdown blocks. Not used when a block has a dedicated spacing token.
- `--markdown-heading-1-space-before` — Used before Markdown Heading 1. Not used after it.
- `--markdown-heading-1-space-after` — Used after Markdown Heading 1. Not used before it.
- `--markdown-heading-2-space-before` — Used before Markdown Heading 2. Not used after it.
- `--markdown-heading-2-space-after` — Used after Markdown Heading 2. Not used before it.
- `--markdown-heading-3-space-before` — Used before Markdown Heading 3. Not used after it.
- `--markdown-heading-3-space-after` — Used after Markdown Heading 3. Not used before it.
- `--markdown-heading-4-space-before` — Used before Markdown Heading 4. Not used after it.
- `--markdown-heading-4-space-after` — Used after Markdown Heading 4. Not used before it.
- `--markdown-heading-floor-space-before` — Used before Markdown Heading 5 and 6. Not used after them.
- `--markdown-heading-floor-space-after` — Used after Markdown Heading 5 and 6. Not used before them.
- `--markdown-list-space-block` — Used around Markdown lists. Not used between list items.
- `--markdown-list-item-space-block` — Used inside Markdown list items. Not used around the list.
- `--markdown-code-block-space-block` — Used around fenced code blocks. Not used around inline code.
- `--markdown-blockquote-space-block` — Used around Markdown quotations. Not used for ordinary paragraphs.
- `--markdown-table-space-block` — Used around Markdown tables. Not used inside table cells.
- `--markdown-rule-space-block` — Used around Markdown rules. Not used for bordered containers.
- `--markdown-media-space-block` — Used around Markdown images and diagrams. Not used inside their controls.

## Theme mapping

Every named color theme and both modes use the same mapping. Standard and Compact are density bindings, not color themes.

Font weight and letter spacing have no primitive scales. The kit owns their fixed values. Density does not vary them.

| Token | Standard | Compact |
|---|---|---|
| `--markdown-body-font-size` | `--rome-font-size-16` | `--rome-font-size-14` |
| `--markdown-body-line-height` | `--rome-line-height-125` | `--rome-line-height-143` |
| `--markdown-body-font-weight` | `400` | `400` |
| `--markdown-body-letter-spacing` | `0` | `0` |
| `--markdown-heading-1-font-size` | `--rome-font-size-24` | `--rome-font-size-20` |
| `--markdown-heading-1-line-height` | `--rome-line-height-133` | `--rome-line-height-120` |
| `--markdown-heading-2-font-size` | `--rome-font-size-22` | `--rome-font-size-18` |
| `--markdown-heading-2-line-height` | `--rome-line-height-127` | `--rome-line-height-133` |
| `--markdown-heading-3-font-size` | `--rome-font-size-20` | `--rome-font-size-16` |
| `--markdown-heading-3-line-height` | `--rome-line-height-120` | `--rome-line-height-125` |
| `--markdown-heading-4-font-size` | `--rome-font-size-18` | `--rome-font-size-14` |
| `--markdown-heading-4-line-height` | `--rome-line-height-133` | `--rome-line-height-143` |
| `--markdown-heading-floor-font-size` | `--rome-font-size-16` | `--rome-font-size-14` |
| `--markdown-heading-floor-line-height` | `--rome-line-height-125` | `--rome-line-height-143` |
| `--markdown-heading-font-weight` | `500` | `500` |
| `--markdown-heading-letter-spacing` | `0` | `0` |
| `--markdown-block-space-between` | `--rome-space-4` | `--rome-space-2` |
| `--markdown-heading-1-space-before` | `--rome-space-6` | `--rome-space-3` |
| `--markdown-heading-1-space-after` | `--rome-space-2` | `--rome-space-1` |
| `--markdown-heading-2-space-before` | `--rome-space-6` | `--rome-space-3` |
| `--markdown-heading-2-space-after` | `--rome-space-2` | `--rome-space-1` |
| `--markdown-heading-3-space-before` | `--rome-space-4` | `--rome-space-2` |
| `--markdown-heading-3-space-after` | `--rome-space-1` | `--rome-space-1` |
| `--markdown-heading-4-space-before` | `--rome-space-4` | `--rome-space-2` |
| `--markdown-heading-4-space-after` | `--rome-space-1` | `--rome-space-1` |
| `--markdown-heading-floor-space-before` | `--rome-space-4` | `--rome-space-2` |
| `--markdown-heading-floor-space-after` | `--rome-space-1` | `--rome-space-1` |
| `--markdown-list-space-block` | `--rome-space-2` | `--rome-space-1` |
| `--markdown-list-item-space-block` | `--rome-space-1` | `--rome-space-1` |
| `--markdown-code-block-space-block` | `--rome-space-4` | `--rome-space-2` |
| `--markdown-blockquote-space-block` | `--rome-space-4` | `--rome-space-2` |
| `--markdown-table-space-block` | `--rome-space-4` | `--rome-space-2` |
| `--markdown-rule-space-block` | `--rome-space-6` | `--rome-space-2` |
| `--markdown-media-space-block` | `--rome-space-4` | `--rome-space-2` |

## Constraints

- Standard body and Headings 1–5 rise from 16px through 24px in 2px steps. Heading 6 shares the heading floor. `[mech]`
- Compact body and Headings 1–4 rise from 14px through 20px in 2px steps. Headings 4–6 share the 14px floor. `[mech]`
- Every heading weighs 500. Size, ink, and position preserve hierarchy when a CJK fallback resolves that weight to Regular. `[mech]`
- A heading keeps its level typography when nested in a quotation or list. Only top-level document blocks receive the outer rhythm tokens. `[mech]`
- The first top-level block has no leading margin, including when the document opens with a heading. `[mech]`
- The `rome-markdown-compact` modifier changes token values only. Element selectors and semantic heading levels stay fixed. `[mech]`
- Streamdown stock typography and margins never define the result. Markdown CSS owns typography and block rhythm. `[mech]`
- Color, border, radius, and font family continue to use Rome's shared semantic tokens. Markdown adds no parallel palette. `[human]`

## Examples

- Positive: a thinking block passes `compact` and a muted color. Compact Markdown tokens set its typography and rhythm.
- Negative: a thinking block passes `text-aux`. A dashboard annotation role cannot describe document prose.
