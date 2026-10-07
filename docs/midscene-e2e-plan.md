# Rome Midscene AI-Native E2E Plan

> Onboarding attachment for Rome maintainers.
>
> Status: all 38 cases catalogued in section 5 are defined as AI-native YAML
> workflows under `tests/midscene/cases/`. Six CI shards split them
> 5/8/7/7/6/5. Each case uses `aiAct` for interaction and `aiAssert` for
> its visible outcome.

## 1. Background and Goals

Rome is a conversation-centric personal AI OS that integrates routines,
approvals, an activity feed and installed apps. Much of its product experience
uses rich interactive cards. A routine proposal changes state inside Chat, an
approval completes inside its card, and an app link opens beside the current
conversation.

This kind of experience has two testing problems:

1. **Selector-based tests are brittle**: card markup, animations, streaming
   renders and virtualized layouts change often.
2. **The real backend is not testable**: features depend on personal accounts,
   IM channels (Telegram/WhatsApp) and third-party services, none of which can
   be reproduced reliably in CI.

This proposal uses [Midscene](https://midscenejs.com/) visual-semantic driving
for problem 1, and Rome's **strict MSW E2E mode** (`pnpm dev:mock:e2e`) for
problem 2: every case runs only against in-repo synthetic fixtures, with no
  real accounts and no external side effects.

Goals:

- Establish a long-lived AI-native E2E baseline for Rome's core product
  stories.
- Serve as a reference implementation for offering Midscene CI to open-source
  projects (deterministic fixtures + visual-semantic assertions + sharded CI).
- Keep browser traffic local, repeatable and mutually non-polluting. The
  Node-side Midscene agent still calls the configured model endpoint.

## 2. Architecture

```
GitHub Actions (6 shards)
  └─ pnpm --filter rome-web dev:mock:e2e    # strict MSW mode, localhost:3200
       └─ tests/midscene (standalone npm package)
            ├─ midscene.config.ts           # Playwright + Midscene config
            ├─ cases/**.yaml                # cases (suite + shard tags)
            └─ Playwright Chromium (1440×900, en-US)
                 └─ fresh BrowserContext per case
                      ├─ localStorage: rome.lang=en
                      ├─ localStorage: rome-sidebar-pins=<full set>
                      └─ in-memory MSW state reset with the context
```

### 2.1 Why a standalone npm package

`tests/midscene` sits outside the pnpm workspace globs (`packages/*`,
`rome_apps/*`, `example_apps/*`) and installs `@midscene/test`,
`@midscene/web` and `playwright` via its own `package-lock.json`:

- Midscene's dependency tree never enters Rome's product dependencies or
  affects production builds.
- CI caches test dependencies and product dependencies separately.
- `npm ci --strict-allow-scripts` runs only the approved `esbuild` and `sharp`
  scripts. The optional `fsevents` script is denied. New scripts fail CI.

### 2.2 Test Harness (`midscene.config.ts`)

- **Fresh BrowserContext per case**: MSW handlers run in a Service Worker
  (`setupWorker`) and keep writes in memory. A new context is a cold start with
  fixtures reset. Zero shared state between cases.
- **Pinned English UI**: an init script writes `rome.lang=en`, so a zh-CN CI
  machine locale cannot drift the copy. A localized Chinese-shell case is
  future coverage. None is included in the current 38-case suite.
- **Full sidebar-pin injection**: the mock guardian pins only Apps/Chat/
  Projects by default. Other entries live behind the "all apps" popover. Cases
  write `rome-sidebar-pins` (the shell's own localStorage contract) so every
  built-in entry is expanded and cross-page sidebar clicks are deterministic.
- **AI-native interaction**: `aiAct` performs navigation, typing, scrolling,
  menu selection, and other user actions from a goal. `aiAssert` checks visible
  outcomes. `app.open` handles isolated setup.
- **Env-driven selection**: `MIDSCENE_INCLUDE_TAGS` / `MIDSCENE_EXCLUDE_TAGS`
  (comma-separated, OR semantics), `MIDSCENE_RETRY`, `HEADLESS` — the same
  entry point serves local single-case iteration and CI sharding.

The harness registers two custom nodes used by committed cases. Each case
uses one `app.open`. Run `npm run nodes` in `tests/midscene` to generate a
local reference for the full node list.

| Node | Purpose |
| --- | --- |
| `app.open` | Open a route in a fresh context, seed language/pins, wait for the sidebar or login page |
| `app.expectRenameConflict` | Check that FILE-03's rename request received HTTP 409 after `aiAct` submitted it |

## 3. Mock-Mode Contract (for Case Authors)

Every case relies on the behavioral facts below. They **document the current
implementation**. If the implementation changes, the cases must change with it.

1. **Fixed cold-start state**: `/api/health`, `/api/bootstrap` and
   `/api/auth/me` drop the app straight into an authenticated shell with the
   synthetic guardian user. The browser is authenticated on open.
2. **Writes are in-memory only**: POST/PATCH operations (enabling a routine,
   approving an approval, installing an app) land in MSW memory and **persist
   across client routes within the same BrowserContext**. A hard reload,
   closing the context, or opening a new one restores fixture defaults.
3. **Unmatched API requests fail locally**: strict E2E mode has no backend
   proxy, and MSW returns 503 for unmocked `/api` calls. Cases must not depend
   on such capabilities (listed as gaps in section 6).
4. **Synthetic fixture data only**: no real names, accounts, tokens or chat
   content may be introduced.
5. **Waiting strategy**: `app.open` waits for the shell (`a[href="/chat"]` in
   the sidebar), which doubles as mock-readiness. Async settling after a card
   mounts (e.g. a routine card re-running `GET /api/routines`) uses explicit
   `wait` steps.
6. **Chat stick-to-bottom**: the transcript snaps to the latest message and
   programmatic scrolling is pushed back by `useStickToBottom`. Only a scroll
   within 300 ms of a trusted gesture (wheel/touch/keyboard) releases it.
   Describe the target message and the scrolling goal in `aiAct`.
7. **In-chat app links**: `/apps/<id>` links in markdown are intercepted by
   `ChatLink` and open in a workspace tile beside the chat while the URL stays
   at `/chat/...`. This is real product behavior. Assert on the tile, not on a
   route change.

## 4. CI Design (`.github/workflows/midscene.yml`)

The workflow file is the source of truth for step-level details (action pins,
timeouts, cache flags). This section records the design decisions and the
reasons behind them.

- **Triggers**: the independent Midscene workflow runs the full model-backed
  suite nightly against the latest upstream `main` commit. Its daily schedule
  is `0 6 * * *` (06:00 UTC / 14:00 Beijing), matching `nightly.yml`.
  It does not depend on the ordinary CI or Nightly workflow.
  Pushes do not trigger it. Pull requests use a scoped path set: the workflow
  itself, `tests/midscene/**`, the [case catalog](midscene-e2e-cases.md),
  `packages/web/**`, `packages/ui/**`, `packages/web-content/**`,
  `packages/api-types/**`, `packages/app-runtime-sdk/**`, and `pnpm-lock.yaml`.
  A matching PR runs two secret-free jobs. `harness-validation` installs the
  package, type-checks it, collects YAML cases, checks the catalog, and tests
  report scripts without starting a browser or model.
  `mock-boundary-validation` starts the mock server and checks MSW, browser
  HTTP, and WebSocket blocking without model credentials.
  Manual `workflow_dispatch` also runs the full suite on upstream `main`.
  A fork owner may manually dispatch a fork branch using that fork's secrets.
  Set `report_source_run_id` to rebuild reports from an existing run's shard
  artifacts without model calls. Report publishing requires the repository to
  match `MIDSCENE_PUBLISH_REPO`.
  The matrix does not run on `pull_request`: model calls are billable and a PR job checks out
  contributor-controlled code. Note that merely naming a protected
  environment in the workflow does **not** create its reviewer gate — an
  absent environment is provisioned open — so until a maintainer actually
  configures a protected environment with required reviewers (ideally with
  environment-scoped secrets), the secret-bearing matrix stays fail-closed
  and runs only against code on the protected default branch. To enable
  model-backed PR runs later, create the protected environment in Settings
  first, then add an environment-gated `pull_request` matrix job back to
  the workflow.
- **Runtime**: Ubuntu + Node.js 24. Pnpm is enabled (reading the root
  `packageManager` version) **before** `setup-node`, whose `cache: pnpm`
  requires pnpm to already exist on a clean runner. Product dependencies
  install with `pnpm install --frozen-lockfile --ignore-scripts`. The
  `tests/midscene` package installs with `npm ci --strict-allow-scripts` against a lockfile whose
  `resolved` URLs all point at the public `registry.npmjs.org`, followed by
  `playwright install --with-deps chromium`.
- **Secret handling and trust boundary**: the four `MIDSCENE_MODEL_*` values
  come from repository secrets and are scoped only to the steps that actually
  call the model (configuration check, connectivity preflight, shard run).
  Dependency installation and the mock server never see them. The job starts
  with a non-empty check and a `/chat/completions` connectivity preflight
  (90-second timeout) so a missing secret or bad endpoint fails in seconds
  instead of burning the full 45-minute budget.
- **Network reachability (important)**: the preflight dials
  `MIDSCENE_MODEL_BASE_URL` directly from the runner. Hosted GitHub runners can
  only reach public endpoints. If the model gateway lives on an intranet (for
  example a corporate-internal hostname), the preflight fails with a connect
  timeout. The workflow then requires a **self-hosted runner** that can reach
  that intranet (change the `runs-on` label) or a publicly reachable model
  endpoint. Correct credentials with no network route fail at the preflight
  just as quickly.
- **Mock server**: `pnpm --filter rome-web dev:mock:e2e` starts in the background
  (it runs `build:kit` first, so first-request readiness is polled for several
  minutes). Its log is uploaded as an artifact on failure.
- **Sharding**: a 6-entry matrix selected by `MIDSCENE_INCLUDE_TAGS=shard-N`.
  Every case carries exactly one `shard-N` tag. `fail-fast: false`,
  `max-parallel: 1`, a 45-minute per-job timeout, and 2 case-level retries.
- **Evidence**: every model-backed run uploads the `midscene_run/` and
  `.midscene/` shard artifacts, including failed runs. A repository with
  `MIDSCENE_PUBLISH_REPO` set to its full name also writes a Markdown job
  Summary. The aggregation job puts abnormal cases first in the run Summary
  and passed cases in a collapsed appendix. Each case has a screenshot and
  exact report-step link when available. Midscene merges the native Test
  reports across shards, and GitHub Pages publishes that report when available.
  An incomplete merge still publishes available shard reports.
- **Network stability**: `NODE_OPTIONS=--dns-result-order=ipv4first
  --no-network-family-autoselection` works around runner-side IPv6 racing when
  the model endpoint is only stable over IPv4.
Shard split:

| Shard | Cases | CI job topic |
| --- | --- | --- |
| shard-1 | 5 | Chat interactions |
| shard-2 | 8 | Apps and chat cards |
| shard-3 | 7 | Routines and sessions |
| shard-4 | 7 | Files, people and activity |
| shard-5 | 6 | Account and settings |
| shard-6 | 5 | Recorded apps and navigation |

The PoC stories also carry their shard tags (E2E-01/02 → shard-3, E2E-03 →
shard-2, AUTH-01 → shard-5).

## 5. Case Catalog

> Case ID convention: `<SUITE>-<number>`. ✅ = mock-drivable (all drafted in
> this iteration), ⚠️ = blocked by a mock gap from section 6 (registered only,
> no YAML).

<!-- CASE-CATALOG -->
The suite contains **38** ✅ mock-drivable cases in 15 YAML files. The
[case catalog](midscene-e2e-cases.md#case-catalog) lists their names and shard
assignments. `npm run collect` validates the expected total and each shard
count against a committed manifest.

### ⚠️ Candidates blocked by section 6 mock gaps (no YAML yet)

| Topic | Candidate cases | Blocking handler |
| --- | --- | --- |
| chat | Real send round-trip, streaming replies, question-card submit success state | turn SSE |
| sessions | `/sessions` Overview metrics page (success-rate/duration charts) | sessions metrics |
| projects | Right-hand projects dashboard summary rendering | projects dashboard |
| chat/sessions | Session fork, share links, archive/delete success paths | fork/share/archive |
| settings/activity | New-channel connection wizard, connection-request Approve success state | connection setup |

## 6. Mock Gaps and Suggested Upstream Handlers

The product capabilities below are not covered by the mock today and block the
⚠️ cases. They suggest five new handlers under `packages/web/mock/handlers/`,
matching the existing house style:

<!-- MOCK-GAPS -->
All of them should follow the existing handler conventions: **synthetic
fixtures + in-memory writes + cold-start reset**, with zero interaction with
real external services.

### 1. Chat turn streaming endpoint (SSE)

- **Today**: sending a message and submitting a question/approval card share
  `POST /api/.../turns`, which the mock does not serve. The UI can only reach
  "Failed to send message". CHAT-04/05/20 therefore assert the designed failure
  state.
- **Suggested**: a turn handler that accepts a synthetic prompt and returns a
  fixed synthetic reply over SSE (message-start → content deltas → tool/card
  block → done), with preset branches for an answered question card and a
  completed approval execution.
- **Unblocks**: successful send round-trips, streaming-typing assertions, the
  locked success state after question submission, sending/stop button states.

### 2. Sessions Overview metrics endpoint

- **Today**: `/sessions` (the Overview segment) depends on
  `POST /api/sessions/metrics`. Unmocked, the whole page is unusable, so all
  sessions cases land on `/sessions/all`.
- **Suggested**: aggregate the existing sessions fixture into fixed-window
  metrics (run counts, success rate, token/cost totals, per-day/per-type
  distributions).
- **Unblocks**: Overview charts/summary rendering, time-window linkage,
  metrics-vs-list consistency assertions (roughly 3–4 ⚠️ cases).

### 3. Projects dashboard endpoint

- **Today**: the left-hand file tree on `/projects` is fully usable, but the
  right-hand dashboard's summary request is unmocked and permanently shows
  "Network error / Retry" (FILE-01 locks this current state in as a baseline).
- **Suggested**: return a synthetic summary for fixture projects (recent files,
  activity, usage and other static aggregates).
- **Unblocks**: normal dashboard rendering, file-selection/summary linkage,
  Retry disappearing after recovery.

### 4. Session fork / share / archive

- **Today**: session writes — fork creation, share links, archive/delete — have
  no handlers, so only failure copy can be verified.
- **Suggested**: in-memory handlers for session writes: fork produces a copy
  with a new id. Share issues a synthetic read-only link (fixed token).
  Archive/delete removes the row from the list and can be restored in memory.
- **Unblocks**: content inheritance after fork, read-only share rendering,
  list disappearance/view filters after archiving, the delete confirmation
  flow.

### 5. Channel connection setup (onboarding wizard and approval)

- **Today**: the three channel connection requests in Activity
  (Telegram/Discord/Feishu) render and can be rejected, but Approve and the
  in-settings new-channel wizard have no success-path handlers.
- **Suggested**: Approve writes to memory and returns a pairing code/success
  state. Add a multi-step GET/POST wizard (choose channel → generate code →
  verify → complete), fully synthetic.
- **Unblocks**: request disappearing and banner decrement after approval, a
  full wizard walkthrough, the connection card appearing in Channels/Settings.

### Mock infrastructure already added for this proposal

- **File-browser watch SSE** (`packages/web/mock/handlers/file-browser.ts`): an
  `/events` SSE stream (subscribers/emit/ready, events mirroring the frontend's
  chokidar watch events). In-mock POST/PATCH/DELETE writes now push
  `add`/`addDir`/`change` immediately, so the file tree reflects writes without
  a full page reload (required by the files/memory cases).
- **Desktop workspace placeholder**
  (`packages/web/mock/public/desktop-vnc.html`): the noVNC document embedded by
  the Browser workspace iframe is served by @rome/core in production. In mock
  mode the missing static asset fell through the SPA fallback into a nested
  /chat. A blank dark placeholder was added at the dev-server static layer (an
  MSW browser Service Worker cannot intercept an iframe's initial document
  navigation, because the new frame has not registered the worker yet).
  The placeholder is mock infrastructure only. A desktop iframe assertion is
  future coverage and is not included in the current suite.

## 7. Running Locally

See `tests/midscene/README.md`. In short:

```bash
pnpm start:web:mock:e2e         # terminal 1: localhost:3200, from repository root
cd tests/midscene
npm install && npx playwright install chromium
cp .env.example .env             # fill in model credentials; .env is gitignored
npm test
MIDSCENE_INCLUDE_TAGS=poc npm test   # PoC stories only
```

## 8. Authoring and Maintenance Conventions

1. Every case starts with exactly one `app.open`. Use `aiAct` for navigation
   within the case.
2. Every case contains at least one `aiAct` and one `aiAssert`. The collection
   check rejects atomic AI nodes and operational `app.*` nodes.
3. Write each `aiAct` as a user goal. Combine related clicks, typing,
   scrolling, and navigation when they serve one intent.
4. Write `aiAssert` prompts against visible outcomes and stable product text.
5. A case carries exactly one `shard-N` tag. Add functional tags such as
   `chat` or `routines` as needed.
6. New cases must pass repeatedly in a fresh context. Inter-case dependencies
   are forbidden.
7. When fixtures change, update case assertions in lockstep. When a new product
   capability is added, add the mock handler before the ⚠️ case.
