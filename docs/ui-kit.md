# UI Kit Packaging

`@rome-os/ui` (`packages/ui`) is the shared React component kit. This file holds its packaging contract: what gets exported, which dependency tier a library belongs in, and who the kit is for. The token layer model it implements is in [design-system.md](design-system.md). The release flow is in [releases.md](releases.md).

## Consumers

The consumers are the dashboard (`packages/web`), first-party apps (`rome_apps/*`), and scaffolded apps. `packages/channel-test-ui`, the browser UI for the channel scenario tests, is a development tool that imports the kit as published. It shapes no API, and it reads the dashboard's theme helpers (`packages/web/src/lib/theme.ts`) for the theme values the kit leaves to the host. Rome Cloud, desktop-base-web, and mobile are explicit non-goals. Do not shape an API around them.

The app scaffold (`packages/app-template/template/package.json`) depends on this package through a concrete `^` range. A release here therefore reaches external apps that no monorepo typecheck covers. Treat the published surface accordingly, and bump the scaffold's range when a new app should start on a newer minor.

## Every component gets a subpath export

Add the `./<component>` entry to `exports` alongside the barrel re-export in `src/index.ts`. A component reachable only through the barrel forces consumers to pull the whole kit. The publishable surface is `exports`, the `files` array, the source behind them, and the dependencies. A change to any of those is a change consumers inherit.

`markdown.tsx` and `command.tsx` have no barrel entry. A component whose peers are **optional** stays subpath-only, because re-exporting it makes the barrel unresolvable for every consumer that skipped those peers.

## Dependencies are load-bearing

`react`, `react-dom`, and `lucide-react` are peers. `clsx` and `tailwind-merge` are regular deps. Radix primitives and `class-variance-authority` belong to that same tier. Install them only when the first component that needs them lands. Declaring a dep before it has a consumer is the same waste in reverse.

Heavy libraries never become regular deps: `streamdown` with its code, math, and mermaid plugins, `katex`, `@dnd-kit/*`, `react-day-picker`, `cmdk`, and `sonner`. They arrive as optional-peer subpath exports, so an app that imports a button does not pay for a calendar. Mirror each optional peer into `devDependencies` as well, or `tsc` and vitest cannot resolve it in this workspace.

## A component's CSS is opt-in when the component is

`src/styles.css` is the canon every host and every app bundle imports, so it may only carry what all of them need. A component shipping hundreds of kilobytes of third-party CSS gets its own stylesheet and its own `./<name>.css` export instead. `markdown.css` is the worked example, and the host imports it alongside the canon.

An app bundle in a Shadow DOM needs that import in its own stylesheet. The host document's copy does not cross the boundary.

## The kit ships style vocabulary, not values

The platform sizing scales, tokens, variants, and base-layer defaults belong in `src/styles.css`. Concrete theme values stay host-owned in `packages/web` and the app-web SDK. The layer rules that keep this sound are in [design-system.md](design-system.md#rules-that-keep-the-two-layers-sound).
