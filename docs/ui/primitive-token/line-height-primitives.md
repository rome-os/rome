# Line Height Primitives

A primitive token doc for the line height dimension. [ui-primitive-tokens.md](../../authoring/ui-primitive-tokens.md) is the rulebook.

## Tokens

One scale, `--rome-line-height-*`, has six steps. A step's name is its ratio times 100, rounded.

A step's value is unitless. Four steps hold a division because a rounded decimal would miss the required value.

| Step | Value | Ratio |
|---|---|---|
| `--rome-line-height-120` | `1.2` | 6/5 |
| `--rome-line-height-123` | `calc(1 / 0.8125)` | 16/13 |
| `--rome-line-height-125` | `1.25` | 5/4 |
| `--rome-line-height-127` | `calc(1.75 / 1.375)` | 14/11 |
| `--rome-line-height-133` | `calc(4 / 3)` | 4/3 |
| `--rome-line-height-143` | `calc(1.25 / 0.875)` | 10/7 |
| `--rome-line-height-175` | `1.75` | 7/4 |

Each division is the target line box in rem over the [font size step](font-size-primitives.md) in rem.

## How the scale is built

- **Every step is a unitless ratio.** A descendant at another size cannot inherit a stale fixed height. `[mech]`
- **One formula derives every step.** Pick the smallest multiple of 4px at or above 1.2 times the font size. Divide that box by the size. `[mech]`
- **The formula fixes nine pairings.** They are 13→16, 14→20, 15→20, 16→20, 18→24, 20→24, 22→28, 24→32, and 30→36. `[mech]`
- **The multiple of 4 puts text on the spacing grid.** Stacked text stays in phase with adjacent boxes. `[mech]`
- **The 1.2 floor contains descenders.** It rules out the nearer box for 14, 15, and 30. `[mech]`
- **The formula picks the step for each size.** Step 123 puts 13px on the grid but puts 14px on 17.2px. `[mech]`
- **One ratio may serve several sizes.** Step 133 is exact for sizes 15, 18, and 24. `[mech]`
- **A step holds the exact ratio, not its rounding.** Flat 1.23 and 1.43 values both miss the grid by a hundredth of a pixel. `[mech]`
- **Chat message prose takes a loose step outside the formula.** Step 175 puts 16px on a 28px box, which stays on the grid. Long answers and CJK text read more easily on it than on the formula's 20px. `[human]`
- **Wrapped text uses the loosest result.** A CJK glyph nearly fills its em box. The 14px pairing leaves a 20px line box. `[human]`

## Forbidden usage

- A call site never writes a line height. Text reads a semantic token, and only semantic tokens read this scale. `[mech]`
- A line height never enters as a length. A fixed box uses box size. A gap between rows uses spacing. `[mech]`
- A step pairs with another size only when the grid formula produces its exact ratio. A new size pairing requires a fresh calculation. `[mech]`
- A value between steps never enters as a one-off. A repeated unmet need triggers a semantic roster decision, then a scale decision. `[mech]`
- A line height never substitutes for spacing. `[llm]`

  > Prefer: a list that opens its rows apart with a spacing step.
  > Over: a list that inflates its line height to air out the rows.
