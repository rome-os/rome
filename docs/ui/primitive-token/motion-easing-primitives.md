# Motion Easing Primitives

A primitive token doc for the motion easing dimension. [ui-primitive-tokens.md](../../authoring/ui-primitive-tokens.md) is the rulebook.

The values live in `packages/ui/src/styles.css`. `packages/web/src/lib/motion.ts` mirrors them as arrays for `motion`, which cannot read a CSS variable, and a test holds the two equal.

## Tokens

One flat scale, `--rome-ease-*`, of two curves. `[mech]`

| Token | Value |
|---|---|
| `--rome-ease-out-expo` | `cubic-bezier(0.16, 1, 0.3, 1)` |
| `--rome-ease-in-out-travel` | `cubic-bezier(0.45, 0, 0.1, 1)` |

## How the scale is built

- **`--rome-ease-out-expo` has no departure.** Its first control point rises at more than 6:1, so the value moves on the first frame and spends the rest of the curve decelerating. `[mech]`
- **`--rome-ease-in-out-travel` has a departure and a long arrival.** Its first control point is flat, and its second sits at x 0.1, so it starts slowly and decelerates over most of its length. `[mech]`
- **Density follows demand.** A curve enters when a transition needs a shape the scale does not hold, and nothing rounds out the run. `[human]`

## Forbidden usage

- A new call site never writes a literal `cubic-bezier()`. `[mech]`
- A curve never overshoots its target. A y value outside 0 to 1 belongs to a spring, which the call site declares through `motion`. `[mech]`
