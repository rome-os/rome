# Storybook

Storybook serves self-contained design demonstrations without a Rome backend. Its initial page-story renders make no service requests. Runtime diagnostic tools and application flows remain in `/dev` and E2E. The dashboard stays on Rsbuild, and unit tests stay on Rstest.

## Start

1. Enter the repository devShell with `nix develop`.
2. Install the workspace dependencies with `pnpm install`.
3. Run `pnpm storybook` from the repository root.
4. Open a page from [Pages](#pages).

The default port is 6006. Use `pnpm storybook --port 6046` for an explicit local instance.
Start `pnpm storybook --port 6047` for a second instance at the same time.
An occupied port fails with an error instead of selecting another port or prompting.
The local development command uses `--no-open` to prevent automatic browser launch while retaining interactive prompts.
For CI, add `--ci` explicitly with `pnpm storybook --ci`.

## Pages

Each story imports its existing page directly. The pages have one implementation.

| Existing development URL | Source | Manager link | Iframe link |
| --- | --- | --- | --- |
| `/dev/styleguide` | `src/pages/dev/StyleGuidePage.tsx` | [`dev-design-styleguide--default`](http://localhost:6006/?path=/story/dev-design-styleguide--default) | [iframe](http://localhost:6006/iframe.html?id=dev-design-styleguide--default&viewMode=story) |
| `/dev/typography` | `src/pages/dev/TypographyPage.tsx` | [`dev-design-typography--default`](http://localhost:6006/?path=/story/dev-design-typography--default) | [iframe](http://localhost:6006/iframe.html?id=dev-design-typography--default&viewMode=story) |
| `/dev/gallery` | `src/pages/dev/gallery/ComponentGalleryPage.tsx` | [`dev-design-gallery--default`](http://localhost:6006/?path=/story/dev-design-gallery--default) | [iframe](http://localhost:6006/iframe.html?id=dev-design-gallery--default&viewMode=story) |
| `/dev/mdx` | `src/pages/dev/mdx/MdxDocsPage.tsx` | [`dev-design-mdx--default`](http://localhost:6006/?path=/story/dev-design-mdx--default) | [iframe](http://localhost:6006/iframe.html?id=dev-design-mdx--default&viewMode=story) |

The iframe link omits the manager UI. Replace the port in these links when you start another instance.

## Retained development routes

The four `/dev` routes stay registered by default in `dev-routes.ts` and stay linked from `DevIndexPage.tsx`.
`App.tsx` maps that registry to the development routes.
`layout-invariants.spec.ts` opens `/dev/styleguide` and `/dev/typography`.
`glyph-size.spec.ts` and `control-size-vocabulary.spec.ts` open `/dev/gallery`.
Storybook provides parallel design demonstrations. It does not replace runtime diagnostic tools or application flows.

## Network-free component states

Each story imports a production renderer and passes typed fixtures or callbacks. The initial render
does not use mock handlers, fetch overrides, or request guards.
Storybook uses the preview browser's detected locale. In a browser check, set the locale before
asserting translated text. Otherwise, assert a role, fixture identity, or local control label.

| Source component | Fixture and state | Story ID | Iframe |
| --- | --- | --- | --- |
| `ChatBlockPreview` → `renderSingleBlock` | `StreamBlock` compact question | [`dev-chat-blocks--compact-question`](http://localhost:6006/?path=/story/dev-chat-blocks--compact-question) | [iframe](http://localhost:6006/iframe.html?id=dev-chat-blocks--compact-question&viewMode=story) |
| `ChatBlockPreview` → `renderSingleBlock` | `StreamBlock` stacked question | [`dev-chat-blocks--stacked-question`](http://localhost:6006/?path=/story/dev-chat-blocks--stacked-question) | [iframe](http://localhost:6006/iframe.html?id=dev-chat-blocks--stacked-question&viewMode=story) |
| `ChatBlockPreview` → `renderSingleBlock` | `StreamBlock` resolved question | [`dev-chat-blocks--resolved-question`](http://localhost:6006/?path=/story/dev-chat-blocks--resolved-question) | [iframe](http://localhost:6006/iframe.html?id=dev-chat-blocks--resolved-question&viewMode=story) |
| `ConnectionDetailDialog` | typed Discord channel, not connected | [`dev-connections-channel-status--not-connected`](http://localhost:6006/?path=/story/dev-connections-channel-status--not-connected) | [iframe](http://localhost:6006/iframe.html?id=dev-connections-channel-status--not-connected&viewMode=story) |
| `ConnectionDetailDialog` | typed Discord channel, connected | [`dev-connections-channel-status--connected`](http://localhost:6006/?path=/story/dev-connections-channel-status--connected) | [iframe](http://localhost:6006/iframe.html?id=dev-connections-channel-status--connected&viewMode=story) |
| `ConnectionSlotCard` | typed Telegram bot, unconnected | [`dev-connections-slot-card--unconnected-bot`](http://localhost:6006/?path=/story/dev-connections-slot-card--unconnected-bot) | [iframe](http://localhost:6006/iframe.html?id=dev-connections-slot-card--unconnected-bot&viewMode=story) |
| `ConnectionSlotCard` | typed Telegram bot, connected | [`dev-connections-slot-card--connected-bot`](http://localhost:6006/?path=/story/dev-connections-slot-card--connected-bot) | [iframe](http://localhost:6006/iframe.html?id=dev-connections-slot-card--connected-bot&viewMode=story) |
| `ConnectionSlotCard` | typed Telegram session, available to add | [`dev-connections-slot-card--add-session`](http://localhost:6006/?path=/story/dev-connections-slot-card--add-session) | [iframe](http://localhost:6006/iframe.html?id=dev-connections-slot-card--add-session&viewMode=story) |

`/dev/connections` stays out of Storybook because it loads application data and owns selected-connection
state. The connection stories pass typed `ConnectionCard` fixtures directly to the production
`ConnectionDetailDialog`. Their initial render does not start a setup. Connection actions retain their
production behavior and belong to application-flow coverage.

`/dev/login` and `/dev/onboard` stay in `/dev` and E2E. Their views depend on `BootstrapPreview`,
the auth query cache, and service-backed submit or setup flows.

## Agent workflow

Start Storybook before connecting an agent. The official `@storybook/addon-mcp` exposes a local
Streamable HTTP endpoint at `http://127.0.0.1:<port>/mcp`. It does not change an agent's settings.

For Codex, add this entry to a trusted project's local `.codex/config.toml`. Do not add it to a
user or workstation configuration, and do not commit the file for this workflow.

```toml
[mcp_servers.rome_storybook]
url = "http://127.0.0.1:6046/mcp"
```

Codex asks for approval before an MCP call by default. If an unattended run uses the loopback
Storybook instance started by this checkout, replace the minimal table with this allowlisted table.
Do not use the approval setting for a remote or untrusted endpoint.

```toml
[mcp_servers.rome_storybook]
url = "http://127.0.0.1:6046/mcp"
enabled_tools = [
  "stories-preview",
  "get-storybook-story-instructions",
  "stories-changed",
  "stories-find-by-component",
  "docs-list",
  "docs-show",
  "docs-show-story",
]
default_tools_approval_mode = "approve"
```

Start a new Codex task after changing the project MCP configuration. An existing task retains its
tool catalog.

For another MCP client, use its project-scoped connection flow. The Storybook helper can create a
project-scoped entry when the client supports it:

```bash
npx mcp-add --type http --url "http://127.0.0.1:6046/mcp" --scope project
```

The endpoint page at `http://127.0.0.1:6046/mcp` shows enabled toolsets. The current local setup
exposes `stories-preview`, `get-storybook-story-instructions`, `stories-changed`,
`stories-find-by-component`, `docs-list`, `docs-show`, and `docs-show-story`.

Before creating or changing a `*.stories.*` file, call `get-storybook-story-instructions`.
Use `docs-list` to discover the current story IDs. Use `docs-show` or `docs-show-story` for the
generated documentation. Use `stories-find-by-component` with a source path to map an edited
component to its story. After a visual edit, call `stories-changed`, then use `stories-preview`
to return the matching manager link.

The manifest covers the current page and fixture stories. It is not a complete props catalog for
published packages. The `test-run` MCP tool stays disabled because this repository does not install
`@storybook/addon-vitest`. Run the existing Playwright command instead. A direct project MCP client
does not receive `review-create` without Storybook's experimental review feature, which this
repository does not enable. Return the manager and iframe links from [Pages](#pages) for review.

`stories-changed` follows Storybook's module graph and Git state. A changed preview or configuration
file can be unreachable from a story. A browser-check file is also unreachable because it has no
visual import. For a renderer, use `stories-find-by-component` instead of inventing a story ID.
Run an unreachable browser check directly.

### Clean local exercise

1. In a clean worktree, run `pnpm storybook --port 6046`.
2. Call `get-storybook-story-instructions`, then discover `dev-design-styleguide--default` with `docs-list`.
3. If MCP is unavailable, use its source and links in [Pages](#pages).
4. Open the [style guide iframe](http://localhost:6046/iframe.html?id=dev-design-styleguide--default&viewMode=story) and confirm the `Design System — Styleguide` heading.
5. Make a temporary source edit in `packages/web/src/pages/dev/StyleGuidePage.tsx`. Confirm HMR updates the open iframe, then restore the source.
6. Run `STORYBOOK_PORT=6046 pnpm --filter rome-web test:storybook`.
7. Return the [style guide manager link](http://localhost:6046/?path=/story/dev-design-styleguide--default) and iframe link. Replace `6046` with the active port.

The same workflow works without MCP. Run `pnpm storybook --port 6047` for a concurrent second
instance. Both commands keep Storybook's exact-port behavior.

## Browser checks

Run `pnpm --filter rome-web test:storybook` to start Storybook and check the direct iframe stories.
Set `STORYBOOK_PORT` to use another development port. Set `STORYBOOK_BASE_URL` to check a running
static build instead. The check covers the selected design story and network-free component states.
It observes initial-render requests and fails for `/api` or another service origin. It does not
intercept or rewrite requests.

## Build and check

1. Run `pnpm build:storybook` in the devShell.
2. Serve the output with `python3 -m http.server 6048 --bind 127.0.0.1 --directory storybook-static`.
3. Open a page from [Pages](#pages), replacing port `6006` with `6048`.
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

Storybook has its own Rsbuild configuration and entry points. Both configurations consume the same pure MDX rule fragment without loading the dashboard configuration.
It does not load the dashboard entry, authentication gate, analytics initialization, backend proxy, or mock entry.
The pages require no API fixtures.
Storybook configuration and story wrappers live outside the dashboard source tree.
The existing `/dev` routes stay available for their current callers.

See the [web package manifest](../packages/web/package.json) for Storybook dependencies and the [workspace catalog](../pnpm-workspace.yaml) for shared version pins.
See the [framework configuration guide](https://storybook.rsbuild.rs/guide/configuration) for builder options.

Initial measurements and verification evidence are recorded in [PR #273](https://github.com/rome-os/rome/pull/273).
