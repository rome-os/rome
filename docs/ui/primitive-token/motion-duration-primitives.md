# Motion Duration Primitives

A primitive token doc for the motion duration dimension. [ui-primitive-tokens.md](../../authoring/ui-primitive-tokens.md) is the rulebook.

The values live in `packages/ui/src/styles.css`. Where this doc and the file disagree, the file is right and the doc updates.

## Tokens

One flat scale, `--rome-duration-*`, of three steps. A step's number is its value in milliseconds. `[mech]`

| Step | Value |
|---|---|
| `--rome-duration-150` | `150ms` |
| `--rome-duration-200` | `200ms` |
| `--rome-duration-300` | `300ms` |

## How the scale is built

- **The steps are the three durations `packages/web/src/` already used.** A count of `duration-*` utilities found 200 fifteen times, 150 six times, and 300 twice. `[mech]`
- **Density follows demand.** A step enters when a transition needs a length the scale does not hold, and nothing rounds out the run. `[human]`

## Forbidden usage

- A new call site never writes a literal duration. It reads a step, or the matching `duration-*` utility, which holds the same value. `[mech]`
- Keyframes in `packages/web/src/globals.css` that predate this scale hold other lengths, such as 280ms and 720ms. A change to one of those keyframes moves it onto a step or adds a step. `[human]`
