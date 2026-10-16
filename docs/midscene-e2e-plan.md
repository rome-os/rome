# Rome Midscene AI-Native E2E Plan

> Onboarding attachment for Rome maintainers.
>
> Status: all 38 cases catalogued in section 5 are defined as AI-native YAML
> workflows under `tests/midscene/cases/` and form the mock suite, which runs
> as one CI job. Each case uses `aiAct` for interaction and `aiAssert` for its
> visible outcome. A second suite, the
> [backend suite](midscene-e2e-cases.md#backend-suite), runs against a real
> Rome container and shares the same report flow.

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
  projects (deterministic fixtures + visual-semantic assertions + one report flow).
- Keep browser traffic local, repeatable and mutually non-polluting. The
  Node-side Midscene agent still calls the configured model endpoint.

## 2. Architecture

```
GitHub Actions (job: mock)
  └─ tests/midscene (standalone npm package)
       ├─ midscene.config.ts           # Playwright + Midscene config
       │    └─ project setup
       │         ├─ pnpm --filter rome-web dev:mock:e2e   # strict MSW mode, localhost:3200
       │         └─ browser network boundary check
       ├─ cases/**.yaml                # cases (topic tags)
       └─ Playwright Chromium (1440×900, en-US)
            └─ fresh BrowserContext per case
                 ├─ localStorage: rome.lang=en
                 ├─ localStorage: rome-sidebar-more-expanded=1
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
- **Sidebar fold opened up front**: the sidebar's fixed menu shows Apps, Chat,
  Projects and Routines. People, Usage, Memory, Activity and Browser sit under
  a fold. Cases write `rome-sidebar-more-expanded=1` (the shell's own
  localStorage contract) so every built-in page is visible and cross-page
  sidebar clicks are deterministic.
- **AI-native interaction**: `aiAct` performs navigation, typing, scrolling,
  menu selection, and other user actions from a goal. `aiAssert` checks visible
  outcomes. `app.open` handles isolated setup.
- **Env-driven selection**: `MIDSCENE_INCLUDE_TAGS` / `MIDSCENE_EXCLUDE_TAGS`
  (comma-separated, OR semantics), `MIDSCENE_RETRY`, `HEADLESS` — the same
  entry point serves local single-case iteration and the CI job.

The harness registers two custom nodes used by committed cases. Each case
uses one `app.open`. Run `npm run nodes` in `tests/midscene` to generate a
local reference for the full node list.

| Node | Purpose |
| --- | --- |
| `app.open` | Open a route in a fresh context, seed the language and the open fold, wait for the sidebar or login page |
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
  Pushes and pull requests do not trigger it. Each suite job type-checks the
  package before it runs cases, and the `mock` project setup checks MSW,
  browser HTTP, and WebSocket blocking before the first case. A broken harness
  or mock boundary fails the next nightly run, so a PR check would only report
  it a day earlier.
  Manual `workflow_dispatch` also runs the full suite on upstream `main`.
  A fork owner may manually dispatch a fork branch using that fork's secrets.
  Report publishing requires the repository to match `MIDSCENE_PUBLISH_REPO`.
  The suite jobs do not run on `pull_request`: model calls are billable and a PR job checks out
  contributor-controlled code. Note that merely naming a protected
  environment in the workflow does **not** create its reviewer gate — an
  absent environment is provisioned open — so until a maintainer actually
  configures a protected environment with required reviewers (ideally with
  environment-scoped secrets), the secret-bearing suite jobs stay fail-closed
  and runs only against code on the protected default branch. To enable
  model-backed PR runs later, create the protected environment in Settings
  first, then add environment-gated `pull_request` suite jobs back to
  the workflow under a `pull_request` trigger.
- **Runtime**: Ubuntu + Node.js 24. Pnpm is enabled (reading the root
  `packageManager` version) **before** `setup-node`, whose `cache: pnpm`
  requires pnpm to already exist on a clean runner. Product dependencies
  install with `pnpm install --frozen-lockfile --ignore-scripts`. The
  `tests/midscene` package installs with `npm ci --strict-allow-scripts` against a lockfile whose
  `resolved` URLs all point at the public `registry.npmjs.org`, followed by
  `playwright install --with-deps chromium`.
- **Secret handling and trust boundary**: the four `MIDSCENE_MODEL_*` values
  come from repository secrets and are scoped only to the steps that actually
  call the model (configuration check, `midscene-test model verify`, suite
  run). Dependency installation and the mock server never see them. The job
  starts with a non-empty check and `model verify`, which checks connectivity
  and Midscene compatibility, so a missing secret or bad endpoint fails in
  seconds instead of burning the job's full time budget.
- **Network reachability (important)**: `model verify` dials
  `MIDSCENE_MODEL_BASE_URL` directly from the runner. Hosted GitHub runners can
  only reach public endpoints. If the model gateway lives on an intranet (for
  example a corporate-internal hostname), `model verify` fails with a connect
  timeout. The workflow then requires a **self-hosted runner** that can reach
  that intranet (change the `runs-on` label) or a publicly reachable model
  endpoint. Correct credentials with no network route fail at `model verify`
  just as quickly.
- **Mock server**: the `mock` project setup starts
  `pnpm --filter rome-web dev:mock:e2e` without the model variables and stops
  it in teardown. It runs `build:kit` first, so readiness is polled for up to
  six minutes. If a server already answers at `ROME_E2E_BASE_URL`, setup uses
  it. The log is `midscene_run/rome-devmock.log`, part of the suite artifact.
- **Suites**: each suite is one job. The `mock` job runs every mock case in
  one Midscene project (`web-mock`) with a 90-minute job timeout and 2
  case-level retries.
  The `backend` job runs after it with the same step order, pulling the
  published image instead of starting the mock server. Each suite's config
  selects its cases by path: `cases/` for `mock`, `backend/cases/` for
  `backend`.
- **Evidence**: each suite job uploads its `midscene_run/` and `.midscene/`
  directories as `midscene-suite-<suite>`, including failed runs, and writes
  Midscene's native `result.md` (counts, failed cases, execution errors) to
  its own job Summary. The `publish` job copies each suite's native HTML
  report to Pages under `runs/<run-id>/<suite>/` and links the reports that
  exist. If Pages fails or is skipped, the suite Summaries and artifacts
  remain available.
- **Timeouts**: `timeout --signal=TERM` stops a suite before its job limit.
  Midscene handles `SIGTERM`: it stops the running case, marks the rest not
  run, and still writes `summary.json`, `result.md`, and the HTML report.
- **Network stability**: `NODE_OPTIONS=--dns-result-order=ipv4first
  --no-network-family-autoselection` works around runner-side IPv6 racing when
  the model endpoint is only stable over IPv4.

## 5. Case Catalog

> Case ID convention: `<SUITE>-<number>`. ✅ = mock-drivable (all drafted in
> this iteration), ⚠️ = blocked by a mock gap from section 6 (registered only,
> no YAML).

<!-- CASE-CATALOG -->
The suite contains **38** ✅ mock-drivable cases in 15 YAML files. The
[case catalog](midscene-e2e-cases.md#case-catalog) lists their names and suite
assignments.

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
cd tests/midscene                # setup starts the mock server on localhost:3200
npm install && npx playwright install chromium
cp .env.example .env             # fill in model credentials; .env is gitignored
npm test
MIDSCENE_INCLUDE_TAGS=poc npm test   # PoC stories only
```

## 8. Authoring and Maintenance Conventions

1. Every case starts with exactly one `app.open`. Use `aiAct` for navigation
   within the case.
2. Every case contains at least one `aiAct` and one `aiAssert`. Do not use
   atomic AI nodes or operational `app.*` nodes beyond the two listed above.
3. Write each `aiAct` as a user goal. Combine related clicks, typing,
   scrolling, and navigation when they serve one intent.
4. Write `aiAssert` prompts against visible outcomes and stable product text.
5. Add functional tags such as `chat` or `routines` as needed. The directory,
   not a tag, decides the suite.
6. New cases must pass repeatedly in a fresh context. Inter-case dependencies
   are forbidden.
7. When fixtures change, update case assertions in lockstep. When a new product
   capability is added, add the mock handler before the ⚠️ case.
