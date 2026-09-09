# Storybook

Storybook serves design demonstration pages without a Rome backend. The dashboard stays on Rsbuild, and unit tests stay on Rstest.

## Start

1. Enter the repository devShell with `nix develop`.
2. Install the workspace dependencies with `pnpm install`.
3. Run `pnpm storybook` from the repository root.
4. Open a page from [Pages](#pages).

The default port is 6006. Use `pnpm storybook --port 6007` for a second instance.
An occupied port fails with an error instead of selecting another port or prompting.
The local development command uses `--no-open` to prevent automatic browser launch while retaining interactive prompts.
For CI, add `--ci` explicitly with `pnpm storybook --ci`.

## Pages

Each story imports its existing page directly. The pages have one implementation.

| Existing development URL | Source | Stable story ID |
| --- | --- | --- |
| `/dev/styleguide` | `src/pages/dev/StyleGuidePage.tsx` | [`dev-design-styleguide--default`](http://localhost:6006/?path=/story/dev-design-styleguide--default) |
| `/dev/typography` | `src/pages/dev/TypographyPage.tsx` | [`dev-design-typography--default`](http://localhost:6006/?path=/story/dev-design-typography--default) |
| `/dev/gallery` | `src/pages/dev/gallery/ComponentGalleryPage.tsx` | [`dev-design-gallery--default`](http://localhost:6006/?path=/story/dev-design-gallery--default) |
| `/dev/mdx` | `src/pages/dev/mdx/MdxDocsPage.tsx` | [`dev-design-mdx--default`](http://localhost:6006/?path=/story/dev-design-mdx--default) |

The [style guide iframe](http://localhost:6006/iframe.html?id=dev-design-styleguide--default&viewMode=story) omits the manager UI. Replace the port in these links when you start another instance.

The adjacent `/dev/connections`, `/dev/chat-blocks`, `/dev/login`, and `/dev/onboard` pages are separate migration candidates. This Storybook surface does not select them.

## Retained development routes

The four `/dev` routes stay registered in `dev-routes.ts` and stay linked from `DevIndexPage.tsx`.
`App.tsx` maps that registry to the development routes.
`layout-invariants.spec.ts` opens `/dev/styleguide` and `/dev/typography`.
`glyph-size.spec.ts` and `control-size-vocabulary.spec.ts` open `/dev/gallery`.
Keep the routes until those callers move to stable Storybook links.

## Build and check

1. Run `pnpm build:storybook` in the devShell.
2. Serve the output with `python3 -m http.server 6008 --bind 127.0.0.1 --directory storybook-static`.
3. Open a page from [Pages](#pages), replacing port `6006` with `6008`.
4. Refresh the page to check the direct link.

The build writes only to the root `storybook-static` directory. The dashboard output stays in `packages/web/dist`.

## Source and theme wiring

The story files in [`packages/web/.storybook/`](../packages/web/.storybook/) import each page directly.
The production-empty development route registry does not select stories.
The preview imports the dashboard stylesheet and uses the real `injectThemeCss` and `ThemeProvider`.
The [design system](design-system.md) owns the theme contract.

Use the preview toolbar's color-mode menu to select Light, Dark, or System.
It drives the real `ThemeProvider`. The specimens and shadow DOM follow the selected mode.
The selection is shareable through Storybook's `globals=colorMode:dark` URL parameter.
Without a Storybook override, the initial mode uses the preview origin's saved `rome-theme` preference.
An explicit global takes precedence and updates that preference before the story paints.
This changes the rendered story. Storybook's sidebar appearance is separate.
The `compareModes` control restores the side-by-side comparison, which remains the default for the original `/dev/styleguide` route.
Comparison columns scope semantic tokens independently. Tailwind `dark:` utilities still match a dark ancestor, including the document root.
Use the single-mode view to verify component variants in each mode.
The palette still comes from `rome-theme-name` in the preview origin's local storage.

The stories import the existing pages rather than copying them. Theme values come from `packages/web/src/lib/themes.ts`, and shared CSS and components resolve to workspace source.
Edits to existing definitions update the development preview through HMR. A served static build must be rebuilt.
The page's token groups and component examples are curated lists, so adding a new token or component does not automatically add an example.

[`rsbuild.config.ts`](../packages/web/.storybook/rsbuild.config.ts) resolves UI and web-content imports to workspace source, including package barrels and subpaths.
Edit `packages/ui/src` or `packages/web-content/src` while Storybook runs to receive HMR.
No package rebuild or server restart is required.
Aliases are generated from each package's `exports`, mapping compiled JavaScript entries to their TypeScript sources and preserving CSS targets.
Published package exports stay unchanged.
Theme context lives in a separate module so changing palette definitions does not recreate its identity during HMR.
Shared UI CSS registers its component sources through `@source`, and the preview uses the dashboard PostCSS configuration.

Storybook has its own Rsbuild configuration and entry points. Its MDX rule matches the dashboard's design-document compiler without loading the dashboard configuration.
It does not load the dashboard entry, authentication gate, analytics initialization, backend proxy, or mock entry.
The pages require no API fixtures.
Storybook configuration and story wrappers live outside the dashboard source tree.
The existing `/dev` routes stay available for their current callers.

See the [web package manifest](../packages/web/package.json) for Storybook dependencies and the [workspace catalog](../pnpm-workspace.yaml) for shared version pins.
See the [framework configuration guide](https://storybook.rsbuild.rs/guide/configuration) for builder options.

Initial measurements and verification evidence are recorded in [PR #273](https://github.com/rome-os/rome/pull/273).
