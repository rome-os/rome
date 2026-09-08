# Dashboard Mock Mode

`pnpm --filter rome-web dev:mock` (from the root, `pnpm start:web:mock`) serves the full dashboard SPA with no backend at http://localhost:3200. An MSW service worker answers `/api` calls from fixtures in `packages/web/mock/handlers/`.

`index.ts` holds the shell probes (`/api/health`, `/api/bootstrap`), chat, and the connection routes. It composes the per-surface modules beside it: `apps.ts`, `activity.ts`, `people.ts`, `routines.ts`, `settings.ts`. The two file browsers go through `file-browser.ts`, an in-memory filesystem the projects tree and the memory dir (`memory-files.ts`) are each served from — `/api/projects` and `/api/memory` are the same routes over a different root, so one factory answers both. The connection ledger itself lives in `connections-store.ts`, because the People page's send routes have to see a grant the Connections page revoked. Unhandled requests pass through the normal dev proxy. With a real backend running on `INTERNAL_API_PORT`, mock mode therefore doubles as an "override one endpoint" tool.

Mock mode is a separate entry (`mock/rsbuild.config.ts` plus `mock/main.tsx`) rather than a dev branch in the SPA. `pnpm build` only reads the root config, so MSW and the fixtures never reach a production bundle.

## Never reimplement what core owns

**A handler does not restate a derivation, a catalog, a value set, or a status mapping that core already owns. Move it to `@rome/api-types` and import it from both sides.** Mock mode is a second implementation of the API, and a second implementation drifts. It drifts silently, because nothing fails when core moves and the fixtures do not. The only rot the build can catch is the kind that crosses a shared import.

Every rule the mock needs and cannot invent lives in `@rome/api-types`. `deriveAppRuntimeStatus` decides an app's runtime status and therefore its open links. `validateCustomAnthropicEnv`, `ANTHROPIC_COMPATIBLE_PROVIDERS` and its summary builder, `APPROVAL_TYPES`, and `APP_MANAGER_ERROR_STATUS` cover the rest. Import those rather than deciding again what a failed app's status is, which providers exist, or which HTTP status a refusal answers with.

The heuristic: if you are about to *decide* something rather than *describe* something, stop. Deciding is the server's job, and the answer already exists somewhere importable. Copying it compiles today and is wrong the first time core changes. What legitimately belongs here is the data itself — which apps are installed, what a transcript says, which routines exist.

The remaining hand-written derivation is the trace segment and summary builder in `mock/handlers/index.ts`, which mirrors core's `createSegmentBuilder`. It is a known exception, not a precedent. It has already drifted twice.

## Both dev scripts rebuild the kit before Rsbuild starts

`dev` and `dev:mock` each run `build:kit` (`pnpm --filter "rome-web^..." run build`) first. The dashboard imports `@rome-os/ui` and `@rome-os/rome-web-components` through their built `dist/` rather than their source. A kit edit is therefore invisible to Rsbuild until something reruns `tsc` in those packages.

The prebuild takes about 3 seconds and runs in topological order. It skips `@rome/api-types`, which exports `src/*.ts` directly and was never stale. Roughly half of `src/components/ui/` is now one-line re-export shims into `@rome-os/ui`. Booting against a stale kit was therefore the common case rather than an edge one.

The prebuild lives in the package scripts rather than the root ones, so no entry point can route around it. `playwright.config.ts` starts its own server with `pnpm dev:mock`, and a root-only prefix would have left `pnpm test:layout` asserting against a stale kit.

Two consequences are worth knowing before iterating.

- **The rebuild happens at startup, so restart to pick up a kit edit.** It closes the gap between the kit's source and what the dev server boots with. It does not make the watcher follow `packages/ui/src`. Rspack defaults `watchOptions.ignored` to `/[\\/](?:\.git|node_modules)[\\/]/`, and the kit resolves through a pnpm symlink under `node_modules`. Writing to `packages/ui/dist` against a running server therefore triggers no rebuild at all, which a probe verified. A `tsc --watch` beside Rsbuild would be a placebo without also overriding that ignore list. Iterating on a kit primitive means restarting each round, or editing under `packages/web/src`, which HMR does watch.
- **A `tsc` failure anywhere in the kit stops the dev server from starting.** That is the intended trade. The alternative is booting against the last-good `dist/`, which is the stale-kit bug wearing a different hat. It hides a broken kit behind a UI that looks fine.

## Writes are real

Writes run against in-memory stores rather than fixed payloads. Approving, toggling an app, creating a routine, or editing the allowed-email list changes what the next read returns.

That is what makes the write-once and fail-closed branches reachable. A second approve is a 409, uninstalling a first-party app is a 400, and deleting a mid-run routine is a 409. It is also why derived fields are projected rather than stored twice. An app card's `accessMode` comes from the `/api/public-access` store the access dialog writes to. A chat session's `messageCount` and `/sessions/search` snippets come from its transcript. A fixture edit therefore cannot leave two surfaces disagreeing.

The four seeded chats carry real transcripts, so opening one renders a populated conversation instead of an empty thread.

## A turn is three rows

Getting the split right is what keeps mock mode honest about what the conversation shows. The assistant row carries only what the API persists as `MessagePart[]`: text, `turn_recap`, `approval_card`, `routine_draft_card`, and the interaction and handoff parts.

Everything a run produced belongs to the trace: `session_init`, `thinking`, tool steps, subagent steps, the `result` accounting footer, and a terminal `error`. The trace lives on a separate `trace` row whose content the messages endpoint blanks to `[]`.

That row exists to carry `traceSummary`, the trigger under the agent's name, and the drawer lazy-fetches the blocks from `/api/chat/messages/:id/content`. Put a tool step in the assistant row and it renders inline in the conversation, which is not a state the product can reach. The fixtures derive each turn's `traceSummary` and segments from its blocks. The trigger's step count, duration, subagent chips, and terminal error therefore cannot disagree with the drawer.

## What mock mode cannot do

Sending is out of scope. There is no model behind it, so `POST /turns` is unhandled and the composer's send fails. Reading a conversation is in scope, and exercising a live turn needs `dev:all`.

Interactive login flows (Claude and Codex device and browser round-trips) are deliberately unhandled. There is no fixture equivalent of a third-party redirect, so their modals surface their own failure.

Embedded `rome_apps` surfaces need the real backend, since `/app-assets` is module federation. Exercise those in `dev:all` rather than here.

The mock filesystem is text. Its tree has no bytes behind it, so upload refuses and the asset and download routes are unhandled — a file browser in mock mode reads, edits, creates, renames, moves and deletes, and moves no binaries.

Fixtures are typed against the same types the fetch sites parse into, either `@rome/api-types` or the web-local type. An API contract change is therefore likely to break `pnpm typecheck` in `mock/handlers/` instead of drifting silently. The caveat is that an empty collection fixture only pins the container shape, not its element type.

When a page's data is needed, add a handler for its endpoints there. Pages with unmocked endpoints render their error and empty states.
