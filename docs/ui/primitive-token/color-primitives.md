# Color Primitives

A primitive token doc for the color dimension. [ui-primitive-tokens.md](../../authoring/ui-primitive-tokens.md) is the rulebook.

The scale is a set of names, and a theme supplies the values, one literal per name. The palettes live in `packages/web/src/lib/themes.ts`. The theme mappings in that file are the only reader. `[mech]`

## Tokens

Six ramps, 68 names. Every theme carries all of them.

`--neutral-*` — 22 steps spanning both modes, from white at 0 to the deepest canvas at 950.

| Step | 0 | 25 | 50 | 100 | 150 | 200 | 250 | 300 | 350 | 400 | 450 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Ember | `#ffffff` | `#fdfcf9` | `#f4f3ef` | `#efe9e1` | `#ece6de` | `#eae6df` | `#e5dfd6` | `#e0d8cd` | `#d0c6ba` | `#c0b4a7` | `#b0a294` |
| Ash | `#ffffff` | `#fefdfb` | `#fbfaf7` | `#f8f7f4` | `#f5f4f1` | `#e7e5e2` | `#dfddd9` | `#d6d4d0` | `#cecbc7` | `#bcb8b3` | `#b0a294` |
| Slate | 1 | .992 | .985 | .97 | .945 | .92 | .9 | .83 | .769 | .708 | .632 |

| Step | 500 | 550 | 600 | 650 | 700 | 750 | 800 | 850 | 900 | 925 | 950 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Ember | `#8a7868` | `#7a6857` | `#6f5c50` | .4 | .32 | .27 | `#2a211b` | .215 | `#1a130f` | .18 | .14 |
| Ash | `#8a7868` | `#7a6857` | `#6f5c50` | .4 | .32 | .27 | `#2a211b` | .215 | `#1a130f` | .18 | .14 |
| Slate | .556 | .493 | .43 | .4 | .3 | .265 | .24 | .21 | .18 | .163 | .145 |

A bare figure is the lightness of an OKLCH value. Slate's sit at chroma 0. Ember's and Ash's dark steps sit at hue 55 and chroma .009 or below.

`--red-*` — 10 steps at hue 27. `--green-*` — 8 steps. `--amber-*` — 9 steps at hue 80. `--blue-*` — 8 steps at hue 250. Every theme holds the same red, amber and blue. Ember and Ash warm the pale end of their green. Lightness and chroma per step:

| Step | Red | Green (Slate) | Green (Ember, Ash) | Amber | Blue |
|---|---|---|---|---|---|
| 50 | .97 / .04 | .97 / .05 | `#e4ead5` | .97 / .05 | .97 / .04 |
| 100 | .94 / .06 | .86 / .09 | .85 / .13 | .94 / .07 | .86 / .08 |
| 150 | — | .85 / .13 | `#c5d2b5` | .88 / .12 | .85 / .13 |
| 200 | .86 / .08 | .72 / .16 | .72 / .16 | .86 / .09 | .7 / .17 |
| 250 | .85 / .13 | — | — | — | — |
| 300 | .7 / .2 | .65 / .17 | `#5b7a4a` | .82 / .14 | .62 / .18 |
| 400 | .58 / .245 | — | — | .78 / .15 | — |
| 500 | .45 / .18 | .45 / .13 | `#44603a` | .45 / .11 | .45 / .16 |
| 600 | .4 / .12 | .4 / .1 | .4 / .1 | .36 / .09 | .42 / .11 |
| 700 | .32 / .09 | .27 / .06 | .27 / .06 | .3 / .07 | .28 / .06 |
| 800 | .27 / .07 | — | — | — | — |

`--orange-*` — 11 steps. Every theme holds the same values:

| Step | 50 | 100 | 200 | 300 | 400 | 500 | 550 | 600 | 700 | 800 | 900 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Value | `#ffead9` | `#fbcda6` | `#f4a268` | `#d86f4c` | `#e55a22` | `#d1490f` | `#c05433` | `#c2410c` | `#b0421a` | `#a63a08` | oklch(0.27 0.05 45) |

## How the scale is built

- **A step number tracks lightness.** On every ramp in every theme, a higher number is a darker step. A theme may repeat a value across neighboring steps. A theme may not invert them. `[mech]`
- **Each chromatic ramp holds one hue.** A step change moves lightness and chroma, never hue. `[mech]`
- **A name says what the value is, and the theme mapping picks the step.** `--neutral-100` is a pale neutral in every theme, and a different pale neutral in each. Two themes may read different steps for one role. `[mech]`
- **The scale is the union of what the themes distinguish, and every theme carries all of it.** No Ember mapping reads steps 250, 350 or 400, and no Slate mapping reads six of its own steps. Those steps exist because another theme separates two depths there. A theme with no use for a whole ramp carries it too: Ember reads no `--blue-*`, Slate reads no `--orange-*`. `[mech]`
- **Density follows demand, not a formula.** The lightness gap between neighbors runs from .001 to .33. Reading a ramp as an even scale gives the wrong answer. `[mech]`
- **Steps bunch at the ends and spread across the middle.** Surfaces stack at the pale end, and in dark mode at the deep end. Text sits mid-ramp, where each text role clears its own contrast bar, so those gaps run wide.
- **Chroma peaks mid-ramp and drops at both ends.** A status ramp is most saturated near mid lightness. Its pale fills and deep dark-mode fills read as a tinted neutral.
- **A half step on a status ramp moves chroma, not lightness.** Each carries two steps near L .85: a low-chroma light-mode border and a high-chroma partner beside it. On a neutral ramp the half step means a lightness between two existing steps. `[mech]`
- **No one step of a hue reads on both ends of its own ramp.** A deep step clears AA on that hue's pale steps and on the neutral canvases. Nothing clears it on the saturated middle, where only a near-white or near-black neutral does. A ramp therefore supports a text role against its pale end or against its mid fill, never one role against both.
- **Ash desaturates Ember at constant lightness through the pale half, and copies it through the deep half.** Red minus blue stays at or under 9 across Ash's steps 25 to 400, against 19 on Ember's surfaces and 35 on its text steps. Desaturating rather than lightening holds the contrast ratios steady. Steps 450 and deeper are identical in the two palettes, because those steps sit at chroma .009, where there is no yellow to remove.
- **`--orange-*` bunches at 500 to 600.** Those three span .04 lightness and differ mainly in chroma. They are the deeper variants Ash needs to clear AA against its lighter surfaces, not three visibly different depths.

## Constraints

Each ratio holds against the named step in the same palette. Moving the value breaks the semantic token that depends on it. `[mech]`

| Palette | Token | Constraint | Measured |
|---|---|---|---|
| every theme | `--orange-300` | White label clears AA-large | 3.3:1 on white |
| every theme | `--orange-400` | Ring clears the 3:1 non-text bar | 3.6:1 on white |
| every theme | `--orange-500` | Ring and chip clear the 3:1 non-text bar. A white label on it misses AA. | 4.4958:1 on white |
| every theme | `--orange-550` | White label clears AA | 4.6:1 on white |
| every theme | `--orange-700` | Info text clears AA standalone on a card | 5.7:1 on Ash's `--neutral-25` |
| every theme | `--orange-700` | Info text clears AA on the info fill | 5.0:1 on `--orange-50` |
| Ash | `--neutral-550` | Muted text clears AA on a card | 5.2:1 on `--neutral-25` |
| Ember | `--neutral-550` | Muted text clears AA on a card | 5.2:1 on `--neutral-25` |
| Ember | `--neutral-450` | Muted text clears AA on the dark canvas | 8.0:1 on `--neutral-950` |

Brand identity fixes `--orange-300` and `--orange-400`. A contrast failure resolves by pointing the semantic token at the matching deeper step, never by moving the brand value. `[human]`

`themes-contrast.test.ts` measures every pairing the mapping declares, per theme and mode, and holds each to its bar. The pairings that ship below it are recorded there with the ratio each measures and tracked in [issue #2167](https://github.com/amantru/rome-internal/issues/2167). The record is two-sided, so a value that improves past its bar fails the test until the stale entry goes. `[mech]`

## Forbidden usage

- A component never references a primitive. Only a semantic token may. `[mech]`
- Primitives stay out of `@theme`, so Tailwind emits no utility for a palette step. `[mech]`
- A raw color value never appears in a component or in a theme mapping. A palette is the one place a literal belongs. `[mech]`
- A palette entry never reads another custom property. `[mech]`
- A theme never omits a name and never adds one of its own. A palette that does not match the scale leaves a surface unpainted under that theme alone. `[mech]`
- A step enters the scale only when a theme mapping needs it, and it enters every palette at once. Nothing rounds out a ramp. `[human]`
