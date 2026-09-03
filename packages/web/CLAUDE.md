# `rome-web`

The Rsbuild SPA dashboard, served by the backend. Guardian-only. It owns the theme values (`src/lib/themes.ts`) that `@rome-os/ui` maps to utilities, and its `mock/` tree is a second implementation of the API.

## Playbook

- Before changing UI, tokens, themes, or component choice, read [`docs/design-system.md`](../../docs/design-system.md).
- Before adding or editing a string a guardian reads, read [`docs/ui/VOICE.md`](../../docs/ui/VOICE.md). A copy change lands in every locale under `src/i18n/locales/`, not just `en`.
- Before adding or editing a mock handler, read [`docs/dashboard-mock-mode.md`](../../docs/dashboard-mock-mode.md).
- When working without a backend, run `pnpm start:web:mock` and open http://localhost:3200.
- When changing a `ui/` primitive or a token, open `/dev/gallery` under `pnpm start:web` — a value defined in only one half of a theme shows up as a broken specimen immediately.

## Traps

**A component that reaches past the semantic tokens renders correctly in the theme you are looking at and breaks in every other one.** Naming a primitive or a raw color compiles, passes lint, and passes the test suite. Theming and dark mode both ride on the semantic indirection, and primitives are referenced in exactly one place: the theme mappings in `src/lib/themes.ts`. [`docs/design-system.md`](../../docs/design-system.md#colors) names what to write instead.

**Focus renders invisible when only part of the outline recipe is written.** These components carry a base that zeroes the outline style, so the width utility alone resolves to no outline. Nothing reports it — the control simply stops showing focus. [`docs/design-system.md`](../../docs/design-system.md#focus-and-invalid-states) carries the full set.

**`@radix-ui/react-dialog` is pinned exactly here and moves in lockstep with `@rome-os/ui`'s pin.** `file-browser/ContextMenu.tsx` imports the primitive directly for its mobile action sheet, so the dashboard bundle carries two entry points into Radix's dialog stack. Radix pins `@radix-ui/react-dismissable-layer` exactly, and that package keeps the open-layer registry plus the saved `document.body.style.pointerEvents` in module scope. Float this range and a dialog opened from a kit menu restores the other copy's saved `none`, leaving the whole page unclickable with a green build.

**A mock handler that decides something rather than describing it drifts silently.** Nothing fails when core moves and the fixtures do not. Import the rule from `@rome/api-types` instead of restating a derivation, catalog, value set, or status mapping.
