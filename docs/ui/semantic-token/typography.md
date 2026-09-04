# Typography Roles

A semantic token doc for the typography role group. [ui-semantic-tokens.md](../../authoring/ui-semantic-tokens.md) is the rulebook. Text on every dashboard and app surface renders in exactly seven roles. Each utility class sets size, line height, letter spacing, and weight together. Every new or migrated surface uses the roles. A surface still on one-off type utilities is unfinished migration, not a pattern to copy. `[mech]`

| Role | Token |
|---|---|
| Display | `text-display` |
| Title | `text-title` |
| Section | `text-section` |
| Body | `text-body` |
| UI Item | `text-ui` |
| Badge | `text-badge` |
| Auxiliary | `text-aux` |

## Why this name

Each role names what the text is, never a size or a look. The roster covers a hero moment, a surface heading, a section heading, prose, a control, a compact labeled container, and an annotation. A surface picks a role by asking what the text is, not what size looks right. `[llm]`

## Usage statement

- `text-display` — Used for the one hero moment on a screen, such as the home greeting. Not used for a second element on the same screen.
- `text-title` — Used for the heading a page or dialog carries once, at the top. Not used for a section inside one.
- `text-section` — Used for the heading of a section, card, or panel inside a surface. Not used for a single control's label.
- `text-body` — Used for prose someone reads as content: chat messages, paragraphs, text typed into a field. Not used for controls or labels. A field on the 28px control step is the single exception and reads `text-ui`. Constraints covers why.
- `text-ui` — Used for controls: sidebar rows, menu items, buttons, tabs, their labels, and both rows of a compact callout such as an alert. Not used for prose.
- `text-badge` — Used for text inside a compact labeled container: chips, tags, badges, status pills, and counters. Not used for metadata that annotates other content, which stays `text-aux`.
- `text-aux` — Used for metadata that annotates other content: timestamps, uncontained counts, group headers, and captions. Not used for compact labeled containers. A column of times or counts adds `tabular-nums`.

## Theme mapping

Every role resolves to the same primitives in light and dark. Other tokens in the family vary by theme — the kit ships names, hosts bind values. The role group reverses that: the kit owns these values, primitives included, and no host, theme, or mode varies them. Size comes from the [font size scale](../primitive-token/font-size-primitives.md), line height from the [line height scale](../primitive-token/line-height-primitives.md). Weight and letter spacing carry too few distinct values to earn a scale, so the group holds them directly. The `/dev/typography` specimen page reads the live values back. `[mech]`

| Role | Font size | Line height | Weight |
|---|---|---|---|
| Display | `--rome-font-size-30` | `--rome-line-height-120` | 400 |
| Title | `--rome-font-size-20` | `--rome-line-height-120` | 400 |
| Section | `--rome-font-size-15` | `--rome-line-height-133` | 500 |
| Body | `--rome-font-size-16` | `--rome-line-height-125` | 400 |
| UI Item | `--rome-font-size-14` | `--rome-line-height-143` | 400 |
| Badge | `--rome-font-size-13` | `--rome-line-height-123` | 500 |
| Auxiliary | `--rome-font-size-13` | `--rome-line-height-123` | 400 |

Letter spacing is 0 in every role.

## Constraints

- Section and Badge carry the only weight other than 400. A CJK system fallback ships no 500 face, so weight matching resolves both roles to Regular there. The emphasis is Latin-only. A bilingual surface separates Section by size, ink, and position, and Badge by its container geometry. `[mech]`
- Letter spacing is 0 in every role. Every candidate value falls below what a reader can see, and the group encodes only visible differences. `[mech]`
- Body and UI Item share a line box at two different sizes, 16px and 14px. Prose reads larger than the controls around it, and the shared box keeps both on the same rhythm. `[mech]`
- Hierarchy comes from size, weight, position, and color. Never compose a second type utility onto a role. For emphasis, use color or position. `[mech]`
- Every role's line box lands on the 4px spacing grid. Retuning a size means taking the line height step cut for it, never carrying the old one across. `[mech]`
- If a size feels wrong, the role choice is wrong or the role mapping needs tuning. Retune on the specimen page, never at the call site. `[human]`
- A field reads Body, which sits at the 16px threshold mobile Safari zooms below. The one exception is the 28px control step: a field there reads UI, because it sits in a compact row beside a Button and a SelectTrigger already on UI, and Body left it two points larger than everything around it. That step is below the 44px touch minimum and so is never a touch target — a field a thumb is meant to hit takes the 36px step, which keeps Body. No surface restores a size exception of its own. `[human]`
- Each role declares all four properties explicitly. A role nested under an inherited weight or letter-spacing utility still renders as drawn. `[mech]`
- Every control declares a role, including an icon-only one. Without one it falls back to the document size, which an em-sized glyph or tooltip resolves against. `[mech]`
- The roster of seven is the contract. Components bind to role names, so a value change never touches a call site. An eighth role enters through a roster decision, never as a new size at a call site. `[human]`
- No per-language variants exist. Surfaces are bilingual inside single elements, so a per-script role has nowhere to be applied. A script-specific adjustment is a host-level value change. `[mech]`
- One approved exception stands outside the group: the home hero serif brand moment keeps its own size, line height, and letter spacing. `[mech]`

## Examples

- Positive: an alert with both rows in `text-ui`, the title in the variant foreground and the description in neutral ink — hierarchy from color inside one role, with no second size or weight.
- Negative: `text-section` on a switch's label inside a settings card, because the label reads faint beside the card heading. A control's label takes `text-ui` and leads by ink. Section gives the card two headings.
