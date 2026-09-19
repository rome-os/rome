# Rome App Authoring Workflow

This document is the **workflow guide** for Rome app development: when to commit, when to install, what to validate, what design rules to follow. It is **not** a triggered skill — `coding:app_creation` directs you to read it once a working tree is set up. Re-read specific sections any time you need a refresher (commit discipline, icon design, delivery checklist, etc.).

> **Companion doc (sibling file, read alongside):**
>
> - [`REFERENCE.md`](./REFERENCE.md) — **file-level API lookup**. On-disk layout; meaning of `app.yaml` / `action.yaml` / agent yaml fields; the `@rome-os/app-runtime` + `@rome-os/app-web-sdk` surfaces; the `rome` CLI; shared-SQLite + `tablePrefix` storage; Tailwind / component-kit / shadow-DOM rules; mobile patterns.
> - [`GAMES.md`](./GAMES.md) — **game-specific authoring guidance**. Read it when the user wants to create a game: how to choose between raw canvas, Three.js, and a real game engine; how to source and ship game assets.
>
> AUTHORING.md is *workflow and what to build*. REFERENCE.md is *how to type each piece*. GAMES.md is *how to make game-specific technical and asset choices*.

**Scope assumption.** Every step below operates on a directory called `<app-root>` — the absolute path to the app's source tree, with a git repo at its root. `coding:app_creation` produces `<app-root>` (via `op: "create"` + `git init`) and points `spec.source` at it.

## Discovering capabilities

The harness already provides much of what an app needs — messaging, scheduling, agent invocation, other apps' actions. Before designing a feature, look up what exists instead of reimplementing it. Your session exposes a **live catalog**:

- **Actions** — `search_actions { query }` finds actions granted to the agent by name, description, or argument text; `read_action { action_name }` returns a per-argument summary (name, type, required, enums, description) plus metadata (`sideEffects`, `requiresApproval`). Nested argument shapes are **not** expanded — confirm complex inputs against the owning app's docs or source. The catalog is live, so granted actions from an app you just applied show up immediately.
- **Skills** — `search_skills { query }` / `read_skill { skill_name }` surface procedure docs shipped by installed apps.
- **Events** — the `system:search_event_catalog` action finds emittable event types, for features that should react to something happening (routine triggers). Each result carries a `payloadSchema` (JSON Schema for the event payload — the fields a routine `trigger.filter` dot-path can match); `schemaOrigin: "observed"` means it was inferred from a recent emission, so treat it as a guide rather than a contract.

Two consequences for the code you write:

- The catalog and `appContext.runAction(canonicalId, args)` are served by the same action registry, so `read_action` is the right starting point for any `runAction` call — ground the canonical `<app-id>:<local-name>` id and arguments in its summary, and for nested arguments confirm the exact shape against the owning app's docs or source. Never guess ids or argument shapes from memory, and never copy an example's arguments unchecked. Calling patterns live in [`REFERENCE.md` → Actions calling actions / agents](./REFERENCE.md#actions-calling-actions--agents).
- If an existing action covers the behavior — sending a message, scheduling a routine, summoning an agent, a Composio tool call — call it via `runAction`. Do not hand-roll an HTTP client, notifier, or scheduler inside the app.

The catalog covers **actions, skills, and events only**. Harness primitives that are not actions — the `appContext` surface (`db`, `log`, `runAction`, settings) and the rest of the `@rome-os/app-runtime` SDK — are documented in [`REFERENCE.md`](./REFERENCE.md), which is their source of truth.

## Product Design

Stateful apps are the recommended shape for Rome apps. Persisting useful
information improves product quality and makes interactions more efficient
than designing around a one-shot action app.

If the guardian closes the app, forgets the conversation, and opens it
tomorrow, the primary UI should still show useful state.

### Product rules

- Store the user-facing record first. The immediate response is not storage.
- Give long-running work a visible status such as `pending`, `in_progress`,
  `completed`, or `failed`.
- Record important behavior somewhere queryable so the UI can explain what
  happened later.
- Avoid using in-memory `Map`s, logs, chat history, or wide JSON blobs as the
  source of truth.

### Product checklist

- [ ] First page shows useful persisted state and core concept or actions.
- [ ] Completed and failed states are visible after reload or restart.

### User-triggered long-running work

When a web UI button starts long-running work such as an agent run, import,
scan, batch API call, or report generation, treat the click as **job creation**,
not as a browser-owned request. The frontend may be closed, refreshed, or
disconnected while the work is still running.

Use a durable backend pattern instead:

- Create a persisted record first with a status such as `pending` or
  `in_progress`, input arguments, timestamps, and enough context to resume or
  explain the run.
- Return to the browser quickly with the job/run id, then run the long task from
  server-side app code, an action, or a one-off routine. Do not require the
  React component, fetch request, or open dashboard tab to remain alive for the
  work to finish.
- Update the persisted record as the task progresses and when it completes or
  fails. The UI should render from that record, with an explicit refresh or
  status view, so the guardian can come back later and see what happened.

## Frontend Design Guideline

This section is intentionally principle-first. It does **not** dictate component templates, exact class strings, or layout shapes — those should emerge from the product. It dictates the **design system discipline** that every Rome app UI must share.

### 1. Token discipline (the only hard rule)

Use the host's semantic tokens for color, surface, and radius — the vocabulary the kit's canon registers (`@rome-os/ui/styles.css`, imported by the SDK stylesheet). Do not paint the UI with raw Tailwind color scales.

- ✅ `bg-[var(--app-canvas)]`, `text-foreground`, `bg-card`, `bg-muted`, `text-muted-foreground`, `bg-primary`, `text-primary-foreground`, `bg-accent`, `border-input`, `border-border`, `bg-destructive`, `text-destructive`, `ring-ring`.
- ❌ `bg-emerald-700`, `text-slate-900`, `border-slate-200`, `bg-rose-50`, `text-emerald-800`, `bg-white/70`.

Why this matters: tokens carry dark-mode pairs and propagate brand changes from a single source. The moment a component hardcodes `emerald-700`, dark mode breaks and the design system fractures.

**Narrow exception — categorical status colors.** When a value belongs to a small fixed enum (e.g. `completed / running / failed / pending`), a Tailwind color paired with its `dark:` variant is acceptable inside a dedicated badge component. Keep the palette small, defined in one place, and never let it leak into chrome.

### 2. Respect the component library

Rome's primitives ship as one published package — `@rome-os/ui`, the same kit the dashboard is built from. The scaffold already depends on it. **Import them; do not copy them.** A copied component is frozen at the moment it was copied: the app can never receive a fix.

- One subpath per component, so a bundler never reaches the whole kit to find one: `import { Button } from "@rome-os/ui/button";`.
- Compose the primitives; do not paint over them. Use `<Button>` through its `variant` and `size` props, not a className that overrides its colors. Use `<Card>` / `CardHeader` / `CardTitle` / `CardContent` for sections instead of hand-rolled `<div>` shells with custom shadows and radii.
- The published set — the controls, the floating family, `Alert`, `Card`, `Spinner`, `Markdown` — is listed in the kit's README ([`@rome-os/ui`](https://www.npmjs.com/package/@rome-os/ui)). Read it before writing a primitive by hand: a few components carry optional peers and their own stylesheet (`Markdown` is the worked example), and the README says which. Kit floating components (dialog, popover, dropdown menu, context menu, select, sheet, tooltip) resolve their own portal container, so they land inside the app's shadow root with nothing to wire.
- Restyle from the call site, never by forking: a kit component's `className` wins over its own variant classes.
- **Only when the kit genuinely lacks the primitive**, copy the canonical shadcn implementation into `components/ui/` — do not invent a divergent one — then re-wire its geometry to the kit control scale (`--control-*` / `--field-*`) so it lines up with kit controls, and point any `Portal` at `getPortalContainer()` ([`REFERENCE.md` → Shadow DOM](./REFERENCE.md#shadow-dom--input-behaviour)).
- Upgrading an app is `pnpm up @rome-os/ui` from `<app-root>` (`--latest` to cross a `0.x` minor), not a re-scaffold. The app owns the only copy of the kit, so the bump moves the components and the stylesheet together — see [`REFERENCE.md` → Styling](./REFERENCE.md#styling).

The goal: a reader landing in any Rome app should recognize the same primitives behaving the same way — because they are literally the same components.

### 3. Restraint over decoration

The default Rome aesthetic is calm, neutral, and information-dense. Decoration must earn its place by serving comprehension, not by signaling effort.

Principles:

- **Surface flatly.** A full app page is `bg-[var(--app-canvas)]`; this semantic arbitrary form works across the scaffold's published UI dependency range. An inline chat component leaves its root canvas transparent because the host supplies the chat context. Put readable text, lists, and tables directly on the page canvas, using spacing and dividers for structure. Use `<Card>` only when a region has an independent boundary or interaction state. Never add a card only to make its text readable. Avoid gradients on page chrome, glassmorphism (`backdrop-blur` + translucent fills), and colored shadows. Reserve heavy visual treatment for genuinely modal contexts.
- **Borders, not auras.** Separation should come from `border` and spacing first, shadow second.
- **Radii stay quiet.** Inputs and buttons are small radii; cards a touch larger; modals slightly more again. Avoid pillow-soft `rounded-2xl`/`rounded-3xl` on every surface — when everything is rounded heavily, hierarchy disappears.
- **Density over drama.** Prefer compact spacing, small icons inside text, and short copy. Heroes, oversize titles, and marketing pills do not belong in an internal tool.

If a visual flourish does not help the user understand or act faster, remove it.

### 4. Stylesheet hygiene

`styles.css` should remain the scaffold baseline: a single `@import "@rome-os/app-web-sdk/styles"` (which brings Tailwind and, through the kit's `@rome-os/ui/styles.css` canon, the host token vocabulary, the `@custom-variant` set, and the `@layer base` resets) plus, at most, a small `:root` block overriding a host token. Treat it as configuration, not as a place to grow features.

- Do not invent custom `@layer components` utilities (`.field`, `.metric`, `.report-markdown`, …). When something repeats, lift it into a React component, not into CSS.
- Do not override the semantic tokens to brand colors. Adjust the tokens themselves only when changing the theme globally and deliberately.
- Prose / markdown styling, when needed, belongs in a typography component (e.g. Tailwind's `prose`) rather than bespoke CSS.

A clean stylesheet is the strongest signal that the design system is intact.

### 5. Typography and copy

- Page title is a single restrained heading; supporting text is muted and short.
- Necessary 13–14px secondary text uses `text-muted-foreground`. Reserve `text-subtle-foreground` for nonessential chrome, and never reduce readable text further with an opacity utility.
- Use sentence case. Avoid slogans, marketing prose, or jokey punchlines in product UI.
- **No emoji in titles or nav labels.** The page title, `app.yaml` `web.navLabel`/`displayName`, and any heading are plain words — no leading 📋/✨/🚀 decoration. Emoji as iconography reads as consumer-app whimsy; a custom SVG icon is how an app gets its glyph.
- **The app's name is Title Case words, never its `appId`.** `app.yaml` `name` / `web.displayName` / `web.navLabel` and the page title read as natural capitalized words — "Morning Brief", "Browser Automation", "Ticket Triage" — *not* the lowercase-hyphenated id (`morning-brief`). The `appId` is the machine identifier (it appears in paths, URLs, and the DB table prefix, so it stays lowercase-hyphenated); the display name is what the guardian sees, so capitalize it. Kebab-case in a heading or nav label is a bug.
- Counts and metadata read more naturally inline ("· 4 repos · 21 reviews") than as separate decorative tiles.

The voice should be the voice of a competent tool: brief, literal, low-temperature.

### 6. State surfaces

Every screen must handle four states explicitly: empty, loading, error, and content. They are part of the design, not afterthoughts.

- **Empty** should explain what the user can do next, in one sentence.
- **Loading** should be quiet — a spinner or skeleton, never a layout shift.
- **Error** uses the destructive token, stays inline near the failing region, and is dismissible when appropriate.
- **Content** is the only state allowed to be visually rich; the others stay subdued so the user's attention lands on real data.

Reuse the same patterns across an app so the user learns them once.

### 7. Interaction and feedback

- Destructive actions live in the destructive variant or use `text-destructive` — never just a red className.
- Selection state is signaled with token-based emphasis (e.g. `border-primary bg-accent`), not colored shadows or glowing rings.
- Asynchronous actions disable their trigger and reflect progress (label change, spinning icon). Avoid `alert()` and avoid implicit background polling loops — prefer an explicit refresh affordance.
- Modal surfaces are the one place where a backdrop is acceptable; keep them narrow and focused on a single task.

### 8. Dark mode is a first-class requirement

If you wrote a color, you wrote it twice: once light, once dark. Tokens do this for you; raw colors do not. Every deviation from §1 must include its `dark:` pair, and the burden of proof is on the deviation.

Before declaring a screen done, switch the theme and look at it. If anything fights the background, the UI is not done.

### 9. Deep-linkable routes

Give every meaningful view its own URL at `/apps/<appId>/<detailId>` (e.g.
`/apps/tickets/T-1423`), not transient component state. The host mounts the app
at `/apps/<appId>/*`, so a sub-path drops the user straight onto a view — which
lets the agent hand over `[Ticket T-1423](/apps/tickets/T-1423)` instead of
"open the app and search".

- Drive views from the route: read it with `getCurrentAppPath()` /
  `subscribeToAppPath(cb)`, change it with `navigateToApp(path)`.
- Keep path ids stable and human-meaningful — they end up in shareable links.

See REFERENCE.md → "Rome App access" for the path shape and helper APIs.

### 10. When in doubt

1. Prefer the smaller, quieter, more semantic choice.
2. If a rule here conflicts with the product's needs, the product wins — but document the deviation and keep it isolated to one component, not spread through the stylesheet.

### Design token reference

When styling an app's web UI, paint only with the host design tokens exposed by
`@rome-os/app-web-sdk`. The full vocabulary — every utility class, the token it
maps to, and when to use it — lives in the SDK README at
`packages/app-web-sdk/README.md`; the canon it documents is the `@theme inline`
block in `@rome-os/ui/styles.css`, which the SDK stylesheet imports, so the kit
components and your own markup paint from one token set. Hardcoding colors
instead of those tokens is a regression (§1).

## Versioned iteration loop

The unit of agent work is a **git commit**. Every non-scaffold iteration must
also leave a dated change note under `<app-root>/docs/`. Every change to an app
goes:

1. Edit files under `<app-root>/src/`. See [`REFERENCE.md` → App Layout & File Meanings](./REFERENCE.md#app-layout--file-meanings) for the on-disk layout and what each file means.
2. Write or update `<app-root>/docs/YYYY-MM-DD-objective.md`, where the date is the current local date and `objective` is a short lowercase-hyphenated summary of the iteration goal. Record what changed, notable product/technical decisions, validation performed, and any follow-ups. If several commits belong to the same date and objective, keep updating the same note instead of creating near-duplicates.
3. `git add -A && git commit -m "<conventional commit message>"` — never `install` uncommitted code; the commit is what makes the change reviewable and revertable, and the docs note is part of that reviewable change. The scaffold's `.gitignore` excludes `.rome/` and `dist/`, so build/pack output never lands in git.
4. Invoke `system:app_management { op: "install", source: { mode: "source", path: "<app-root>" } }` — one call; the daemon runs the workspace's `pnpm install` + `pnpm build` (= `rome build`, backend tsc → `dist/` plus web bundle rslib → `dist/web/`), packs into `<app-root>/.rome/artifact`, and hot-swaps the new code. Pass `source` on every install — the daemon does not infer it from the lockfile, so every re-install repeats the same source as the first install.
5. Validate against the running app.
6. Refresh `/apps` or `/apps/<appId>` in the dashboard to pick up the changes.

Every install rebuilds and repacks, so YAML-only or migration-only edits need nothing extra — the same single call ships them. Run `pnpm build` locally only when you want build errors before installing (or `rome dev` for web HMR).

## App Assets

Move app-owned static assets such as images, audio, fonts, and fixture files into `<app-root>/src/assets/` so they are copied into the bundled artifact and shipped with the app under its `<appId>/assets/` namespace. Do not leave required assets in local scratch directories, absolute workspace paths, or remote-only URLs unless the app is intentionally fetching live external content.

## Game apps

When the user wants to create a game, read [`GAMES.md`](./GAMES.md) before choosing the renderer, engine, or art pipeline. Game apps need different tradeoffs from dashboards: pick simple browser primitives for toy interactions, but consider a real game engine and sourced asset packs for real gameplay.

## Background music

Most Rome apps are tools, and tools are silent. Add background music only when the app is an *experience* the guardian inhabits — like §3's decoration rule, it must earn its place:

- **Entertainment** — games, trivia, party apps, story/roleplay experiences where immersion is the product.
- **Ambience-driven** — meditation, sleep, spa-like, or focus/pomodoro flows where the soundscape *is* part of the feature.
- **Momentarily celebratory** — short stingers on win or completion screens (seconds, not a loop).

Ship silent everywhere else — utilities, dashboards, data-dense tools, anything kept open alongside other work, and apps that already play voice or user media — and whenever in doubt.

If music qualifies, follow [`BACKGROUND_MUSIC.md`](./BACKGROUND_MUSIC.md): the bundled royalty-free catalog and its search script, genre-to-app fit, and playback rules (user-gesture start, quiet default, persistent mute, stop on navigation).

## App Icon

Every app must ship a professional, modern SVG icon at `<app-root>/src/assets/icon.svg`, referenced from `app.yaml` as `icon: assets/icon.svg`. **Always design a custom icon that matches the user's intent and the app's actual use case** — do not reuse a generic placeholder, and do not skip this step.

Requirements:

- Author the icon by hand in SVG (or refine one until it fits). The mark should communicate what the app *does* at a glance — pick a metaphor grounded in the app's domain (e.g. chevrons for a code editor, an inbox tray for messaging, a calendar grid for scheduling).
- Use `viewBox="0 0 24 24"` and ship a **self-contained tile**: a rounded `<rect width="24" height="24" rx="5.5">` as the background, then the glyph drawn on top. The app picks both the tile color and the glyph color — the host renders the SVG verbatim and adds no tint, so the choice is yours.
- Use a consistent `stroke-width` (typically `0.9`–`1.2`) with `stroke-linejoin="round"` and `stroke-linecap="round"`. Keep the glyph centered with a comfortable margin from the tile edge — aim for the visual weight and clarity of `lucide-react` icons.
- Use explicit hex colors (`fill="#…"`, `stroke="#…"`). Pair a soft tile background with a darker, well-contrasting glyph so the mark reads at 24px in both light and dark themes.
- Keep the file small (well under 2 KB) and ship a single root `<svg>` element.

Before declaring the app done, open the icon in the dashboard sidebar and confirm it reads clearly at small sizes in both light and dark themes.

## App Store Listing

Every app ships store-facing copy in two places. The scaffold materializes placeholders for both; replace them before declaring the app done.

- `<app-root>/.rome_store/rome_store.yaml` is the Rome Cloud store metadata sidecar: title, summary, long description, categories, keywords, and optional store-only image/video media.
- `<app-root>/README.md` is the listing readme body shown on the store page.

Write both as product copy, not technical documentation:

- Lead with what the app *does* for the user, in one or two sentences.
- List the main features as short bullets, framed from the user's point of view.
- Mention the situations where someone would reach for this app.
- **Do not** include schemas, file paths, build commands, action/API names, or implementation details. That all belongs in source comments or commit messages, not in the listing.
- Keep it short — a few headings is enough.

The packed artifact picks the top-level `README.md` up automatically (it does **not** go under `dist/` or `src/`). The publish flow uploads `.rome_store` separately and excludes it from installed app bundles, so store screenshots and videos should live under `.rome_store/assets/`, not `src/assets/`.

## Recurring runs

When a user asks for recurring runs—for example, "do X every day" or "run this every week"—treat the request as two separate pieces of work:

1. **One-time setup.** Do the initial exploration and build any required infrastructure. For example, create the dashboard, define the data schema, connect sources, or set up the table where future results will be stored.

2. **Recurring execution.** Create a routine (via `appContext.runAction("system:create_routine", …)` — see [`REFERENCE.md` → Creating routines](./REFERENCE.md#creating-routines-systemcreate_routine)) that updates the system on the requested interval. For example, every week it might pull fresh data from a source, transform it, and append or update structured rows in a table.

Important: future scheduled runs do not automatically retain the context of the current run. The scheduled action must therefore be fully self-contained.

To make the recurring task self-contained, either:

- call `system:summon` with a canonical agent id and detailed instructions that include all required context, sources, schemas, and expected outputs; or
- create a new action that contains every step needed for the recurring work, such as running shell commands, calling APIs, analyzing results, updating files or tables, and sending messages.

Do not assume the scheduled run will remember decisions, files, variables, or context from the setup run unless they are explicitly included in the scheduled action or stored in the memory.

## Boundaries

- Keep each feature inside its owning app. App runtime code should import only files inside the same app, Node builtins, declared runtime dependencies, and stable shared packages (`@rome-os/app-runtime`, `@rome-os/app-web-sdk`, and — in `src/web/` only — `@rome-os/ui`).
- Treat `@rome-os/app-runtime` (backend SDK), `@rome-os/app-web-sdk` (web SDK + `rome` CLI), and `@rome-os/ui` (component kit, web only) as the public app boundary. Do not import runtime code from repo `src/` or from another app. See [`REFERENCE.md` → Boundaries & Anti-patterns](./REFERENCE.md#boundaries--anti-patterns) for the full anti-pattern list.
- Prefer extending an existing app when the capability fits its boundary. Create a new app only when the ownership line is clearly separate.
- The bundled template (materialized by `op: "create"`) is intentionally minimal but complete — one action, one API route, one DB table, one default-export React UI. Treat it as a starting point: **delete what your app does not need** rather than carrying dead boilerplate. If a whole capability is unused (DB, web UI, API, the sample action), remove its files **and** the matching `app.yaml` section together — leaving one without the other will fail validation or build.

## Validation

Before declaring a change done, from `<app-root>` run:

```sh
pnpm install                                                          # if you added a dep or just created the app
tsc --noEmit                                                          # full type check (covers backend + web)
pnpm build                                                            # catch build errors locally before installing
git status                                                            # working tree must be clean — every change is committed before install
```

Then call `system:app_management { op: "install", source: { mode: "source", path: "<app-root>" } }` — the daemon rebuilds, repacks, and installs in one step — and exercise the action / API / UI you changed.

For newly created apps, finish with an independent clean-context verification
pass: call `system:summon` with `agentName: "assistant:assistant"` and only the app id,
`<app-root>`, packed artifact path, expected behavior, dashboard/API base URL,
and safe sample inputs. Instruct it to load
[`coding:app_verification`](../app_verification/SKILL.md), visit/probe the installed
app, and report a pass/fail/blocked verdict with evidence and gaps. Do not
claim the app works solely from the creator's own smoke test.

## Delivery Checklist

- Replace the placeholders in `<app-root>/.rome_store/rome_store.yaml` and `<app-root>/README.md` with App Store listing copy for the finished app — features and use cases in product language, no implementation details
- Update `app.yaml` when you add a new action, agent, skill, web entry, API entrypoint, or DB section
- Add runtime package dependencies to `<app-root>/package.json` instead of relying on root dependency resolution
- Add or update `<app-root>/docs/YYYY-MM-DD-objective.md` for the iteration, covering changed behavior, important decisions, validation, and follow-ups
- Commit (`git add -A && git commit`) before every `install` — uncommitted source is not a valid release input. The scaffold's `.gitignore` excludes `.rome/` and `dist/`, so build/pack output stays out of git
- Invoke `system:app_management { op: "install", source: { mode: "source", path: "<app-root>" } }` after every change — one call rebuilds, repacks, and installs; `source` is required on every install, the daemon does not infer it from the lockfile
- Refresh `/apps` to confirm the dashboard lists the app, and refresh `/apps/<appId>` to confirm the mounted UI loads
- Verify the action, API route, or UI path you added actually runs
- Use `system:summon` with `assistant:assistant` to run `coding:app_verification` against the installed app and include its verdict, runtime evidence, gaps, and suggested extra checks in the final handoff
- Add or update tests close to the code you changed
- Keep system-level runtime primitives in core and product behavior inside apps
- When you finish all the work, provide the user with an app link using `[<appName>](/apps/<appId>)`, not a localhost URL or a domain URL. When the work focused on a specific entity, link its detail route directly — `[<label>](/apps/<appId>/<detailId>)` — so the user lands on it without navigating (this only works if the app exposes deep-linkable routes, see Frontend Design Guideline §9)
