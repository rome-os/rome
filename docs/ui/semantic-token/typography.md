# Typography Roles

A semantic token doc for the typography role group. [ui-semantic-tokens.md](../../authoring/ui-semantic-tokens.md) is the rulebook. Text on every dashboard and app surface renders in exactly seven roles. Each utility class sets size, line height, letter spacing, and weight together. Every new or migrated surface uses the roles. A surface still on one-off type utilities is unfinished migration, not a pattern to copy. `[mech]`

| Role | Token |
|---|---|
| Display | `text-display` |
| Title | `text-title` |
| Section | `text-section` |
| Composer | `text-composer` |
| UI Item | `text-ui` |
| Badge | `text-badge` |
| Auxiliary | `text-aux` |

**Prose is not in this group.** Content someone reads at length is Markdown, and Markdown sizes itself from the [`--markdown-*` tokens](../../design-system.md#typography), which carry their own heading ladder and a compact density. The roles above are the interface: headings, controls, labels, annotations. The first question a surface asks is not which role but which family — rendered Markdown, or interface. `[llm]`

## Why this name

Each role names what the text is, never a size or a look. The roster covers a hero moment, a surface heading, a section heading, the chat composer, a control, a compact labeled container, and an annotation. A surface picks a role by asking what the text is, not what size looks right. `[llm]`

Composer names the one surface it belongs to, unlike its neighbours. That is the point: it is 16px because the message it produces renders at 16px, and it has no second call site to generalise over. A role that named the size, or named prose, would invite every paragraph in the dashboard back onto it. `[llm]`

## Usage statement

- `text-display` — Used for the one hero moment on a screen, such as the home greeting. Not used for a second element on the same screen.
- `text-title` — Used for the heading a page or dialog carries once, at the top. Not used for a section inside one.
- `text-section` — Used for the heading of a section, card, panel, or dialog inside a surface. Not used for a single control's label.
- `text-composer` — Used for the chat composer's input, and nothing else. It matches the Markdown body size that the sent message renders at, so what someone types is the size of what they get. Not used for other fields, which read UI like every control, and not for prose, which is Markdown.
- `text-ui` — Used for controls and everything that explains them: sidebar rows, menu items, buttons, tabs, text fields and their labels, a section's description, a card's description, a dialog's description, and both rows of a compact callout such as an alert. Not used for rendered Markdown.
- `text-badge` — Used for text inside a compact labeled container: chips, tags, badges, status pills, and counters. Not used for metadata that annotates other content, which stays `text-aux`.
- `text-aux` — Used for metadata that annotates other content: timestamps, uncontained counts, group headers, and captions. Not used for compact labeled containers. A column of times or counts adds `tabular-nums`.

## Theme mapping

Every role resolves to the same primitives in light and dark. Other tokens in the family vary by theme — the kit ships names, hosts bind values. The role group reverses that: the kit owns these values, primitives included, and no host, theme, or mode varies them. Size comes from the [font size scale](../primitive-token/font-size-primitives.md), line height from the [line height scale](../primitive-token/line-height-primitives.md). Weight and letter spacing carry too few distinct values to earn a scale, so the group holds them directly. The `/dev/typography` specimen page reads the live values back. `[mech]`

| Role | Font size | Line height | Weight |
|---|---|---|---|
| Display | `--rome-font-size-30` | `--rome-line-height-120` | 400 |
| Title | `--rome-font-size-18` | `--rome-line-height-133` | 500 |
| Section | `--rome-font-size-15` | `--rome-line-height-133` | 500 |
| Composer | `--rome-font-size-16` | `--rome-line-height-125` | 400 |
| UI Item | `--rome-font-size-14` | `--rome-line-height-143` | 400 |
| Badge | `--rome-font-size-13` | `--rome-line-height-123` | 500 |
| Auxiliary | `--rome-font-size-13` | `--rome-line-height-123` | 400 |

Letter spacing is 0 in every role.

## Constraints

- A description sits at the same size as the control it explains, and leads by ink. A section's description, a card's description, and a dialog's description are all `text-ui text-muted-foreground`. A field's helper and error are `text-aux`, one step down, because they annotate a single control rather than introduce a group. A description never takes a heading role, which would give its container two headings. `[human]`
- Title, Section, and Badge carry the only weight other than 400. A CJK system fallback ships no 500 face, so weight matching resolves all three roles to Regular there. The emphasis is Latin-only. A bilingual surface separates Title and Section by size, ink, and position, and Badge by its container geometry. `[mech]`
- Letter spacing is 0 in every role. Every candidate value falls below what a reader can see, and the group encodes only visible differences. `[mech]`
- Composer and UI Item share a line box at two different sizes, 16px and 14px. The composer reads larger than the controls around it, and the shared box keeps both on the same rhythm. `[mech]`
- Hierarchy comes from size, weight, position, and color. A call site never composes a second type utility onto a role. For emphasis there, use color or position. The kit itself lifts two members above the UI role's weight, the primary `Button` label to 500 and `AlertTitle` to 600, because each sits in a box whose other text shares its size and ink. Those lifts live in the component, never at a call site. `[mech]`
- Every role's line box lands on the 4px spacing grid. Retuning a size means taking the line height step cut for it, never carrying the old one across. `[mech]`
- If a size feels wrong, the role choice is wrong or the role mapping needs tuning. Retune on the specimen page, never at the call site. `[human]`
- A field reads UI at every step, like every control on its row. A Button, a SelectTrigger, and an Input of one size name share one font size as well as one height, and a combobox's field matches the options under it. The 16px threshold below which mobile Safari zooms a focused field does not apply here: the dashboard's viewport meta pins `maximum-scale=1`, which suppresses that zoom. No surface restores a field size exception of its own. `[human]`
- Each role declares all four properties explicitly. A role nested under an inherited weight or letter-spacing utility still renders as drawn. `[mech]`
- Every control declares a role, including an icon-only one. Without one it falls back to the document size, which an em-sized glyph or tooltip resolves against. `[mech]`
- The roster of seven is the contract. Components bind to role names, so a value change never touches a call site. An eighth role enters through a roster decision, never as a new size at a call site. `[human]`
- No per-language variants exist. Surfaces are bilingual inside single elements, so a per-script role has nowhere to be applied. A script-specific adjustment is a host-level value change. `[mech]`
- One approved exception stands outside the group: the home hero serif brand moment keeps its own size, line height, and letter spacing. `[mech]`

## Examples

- Positive: an alert with both rows in `text-ui`, the title at the kit's 600 step in the variant foreground and the description at 400 in neutral ink — hierarchy from weight and color inside one size and line box.
- Negative: `text-composer` on a settings page's section description, because 14px looked small beside the heading. The description reads UI and leads by ink. Composer belongs to the chat input alone.
- Negative: `text-section` on a switch's label inside a settings card, because the label reads faint beside the card heading. A control's label takes `text-ui` and leads by ink. Section gives the card two headings.
