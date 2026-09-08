# Storybook

Storybook serves the existing style guide without a Rome backend. The dashboard stays on Rsbuild, and unit tests stay on Rstest.

## Start

1. Enter the repository devShell with `nix develop`.
2. Install the workspace dependencies with `pnpm install`.
3. Run `pnpm storybook` from the repository root.
4. Open [the style guide](http://localhost:6006/?path=/story/dev-design-styleguide--default).

The default port is 6006. Use `pnpm storybook --port 6007` for a second instance.
An occupied port fails with an error instead of selecting another port or prompting.
The local development command uses `--no-open` to prevent automatic browser launch while retaining interactive prompts.
For CI, add `--ci` explicitly with `pnpm storybook --ci`.
When debugging through Codex, prefer its built-in browser.

The stable story ID is `dev-design-styleguide--default`.
The [direct iframe](http://localhost:6006/iframe.html?id=dev-design-styleguide--default&viewMode=story) omits the manager UI.
Replace the port in either link when you start another instance.

## Build and check

1. Run `pnpm build:storybook` in the devShell.
2. Serve the output with `python3 -m http.server 6008 --bind 127.0.0.1 --directory storybook-static`.
3. Open [the static style guide](http://localhost:6008/?path=/story/dev-design-styleguide--default).
4. Refresh the page to check the direct link.

The build writes only to the root `storybook-static` directory. The dashboard output stays in `packages/web/dist`.

## Source and theme wiring

[`StyleGuide.stories.tsx`](../packages/web/.storybook/StyleGuide.stories.tsx) imports the page directly.
The production-empty development route registry does not select stories.
The preview imports the dashboard stylesheet and uses the real `injectThemeCss` and `ThemeProvider`.
The [design system](design-system.md) owns the theme contract.

Use the preview toolbar's color-mode menu to select Light, Dark, or System.
It drives the real `ThemeProvider`. The specimens and shadow DOM follow the selected mode.
The selection is shareable through Storybook's `globals=colorMode:dark` URL parameter.
This changes the rendered story. Storybook's sidebar appearance is separate.
The `compareModes` control restores the side-by-side comparison, which remains the default for the original `/dev/styleguide` route.
The palette still comes from `rome-theme-name` in the preview origin's local storage.

The story imports the existing page rather than copying it. Theme values come from `packages/web/src/lib/themes.ts`, and shared CSS and components resolve to workspace source.
Edits to existing definitions update the development preview through HMR. A served static build must be rebuilt.
The page's token groups and component examples are curated lists, so adding a new token or component does not automatically add an example.

[`rsbuild.config.ts`](../packages/web/.storybook/rsbuild.config.ts) resolves UI and web-content imports to workspace source, including package barrels and subpaths.
Edit `packages/ui/src` or `packages/web-content/src` while Storybook runs to receive HMR.
No package rebuild or server restart is required.
Published package exports stay unchanged.
Shared UI CSS registers its component sources through `@source`, and the preview uses the dashboard PostCSS configuration.

Storybook has its own Rsbuild configuration and entry points.
It does not load the dashboard entry, authentication gate, analytics initialization, backend proxy, or mock entry.
The style guide requires no API fixtures.
Storybook configuration and story wrappers live outside the dashboard source tree.
The existing `/dev` routes stay available for their current callers.

The selected versions are `storybook-react-rsbuild` 3.4.2 and Storybook 10.6.0, with the workspace Rsbuild 2.2.3 and React 19.2.6 pins.
See the [framework configuration guide](https://storybook.rsbuild.rs/guide/configuration) for builder options.

## Integration verification

Measured on macOS arm64 with Node 24.14.0 and pnpm 11.6.0 in the devShell, with dependencies and browser binaries already installed:

| Measurement | Result |
| --- | --- |
| Fresh server process: command to ready | 5.237 s |
| Fresh server process: command to rendered style guide | 5.706 s |
| Static build wall time | 5.447 s |
| Static output | 96 files, 10,062,061 bytes |

These are single-run observations, excluding devShell startup and installation.
The startup measurement used `--ci`. The local script now uses `--no-open`.

The development and served static stories passed the six theme/mode checks.
Temporary edits through existing consumers verified UI and web-content HMR without page reloads or changes to either package's `dist` output. The edits were restored.
The dashboard build passed, and its 388 source maps contained no Storybook, story, mock, MSW, or style-guide entries.
React, React DOM, and the shared Radix Dialog resolved to single instances across their consumers.

Host type checking and the complete unit command passed: 4,360 core tests, 1,384 web tests, 559 UI tests, and 153 other workspace tests.
An earlier combined run had three core failures. Both a focused rerun and the later complete run passed.
The fullstack development container reached `Rome started`.

The color-mode toolbar was exercised in Codex's built-in browser, including Light, Dark, System, and the comparison control.
A temporary edit to the real dark-background definition updated the preview and its displayed color value automatically. Restoration updated it again.
Theme context lives in a separate module so changing palette definitions does not recreate its identity during HMR.
