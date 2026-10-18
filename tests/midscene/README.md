# Rome × Midscene Visual E2E

Visual-driven end-to-end testing for Rome using
[Midscene](https://midscenejs.com/) YAML cases, in two suites:

- **mock** (`cases/`, `midscene.config.ts`): runs against Rome's **strict MSW
  E2E mode** (`pnpm --filter rome-web dev:mock:e2e`), which project setup
  starts. It never hits a real backend or uses real personal data. The browser
  only loads local synthetic fixtures.
- **backend** (`backend/cases/`, `midscene.backend.config.ts`): runs against a
  real Rome container from the published image, with a real model. See the
  [backend suite](../../docs/midscene-e2e-cases.md#backend-suite).

The Node-side Midscene agent calls the configured model endpoint in both.
The rest of this README describes the mock suite unless it names the backend
suite.

> The companion planning doc is
> [`docs/midscene-e2e-plan.md`](../../docs/midscene-e2e-plan.md) (case catalog,
> mock contract, CI design).

## How It Works

- Project setup in `midscene.config.ts` starts the strict mock server
  (`mock-server.ts`) unless one already answers at `ROME_E2E_BASE_URL`. The
  server gets no model variables, and its log is
  `midscene_run/rome-devmock.log`. Teardown stops the server it started.
- Setup then launches Playwright Chromium and checks the browser network
  boundary (`browser-boundary.ts`) before the first case. Each case gets a
  **fresh BrowserContext**: in-memory MSW state resets with the context, so
  every case starts from the same fixtures.
- An init script seeds two localStorage contracts only when the app has no
  stored value yet (it does not overwrite a case's own choice, so a language
  switch or sidebar edit persists across navigation):
  - `rome.lang = en`: pins the English UI (avoids locale interference on a
    Chinese CI machine);
  - `rome-sidebar-more-expanded = 1`: opens the sidebar fold, so People,
    Usage, Memory, Activity and Browser show beside the fixed menu.
- The strict E2E worker rejects external HTTP requests. A BrowserContext guard also
  blocks external HTTP and WebSocket traffic. The setup check fails the run if
  either path lets a request out. Strict E2E mode disables the backend proxy,
  and unmatched `/api` requests return 503 locally.
- Every case uses Midscene's `aiAct` for user interaction and `aiAssert` for
  visible outcomes. `app.open` provides the isolated starting route, and
  `wait` covers fixed mock settling time.
- The suite contains 38 AI-native cases. Each case starts one isolated product
  goal. Related page states share a case only when they belong to that goal.
- The package registers `app.open` for isolated setup and
  `app.expectRenameConflict` for FILE-03's transient response. Run
  `npm run nodes` to generate a local node reference with their parameters.
- All mock cases live in `cases/**/*.yaml`, organized by topic file, with
  topic tags. The directory decides the suite.

## Prerequisites

- Node.js 24 (the repo pins it via fnm: `eval "$(fnm env)" && fnm use 24`)
- Rome dependencies installed (`pnpm install` at the repo root)
- Credentials for the visual model Midscene uses (an OpenAI-compatible API)

## Running Locally

```bash
# 1. Install test dependencies (first time only)
cd tests/midscene
npm ci --strict-allow-scripts
npx playwright install chromium

# 2. Configure model credentials (first time only; .env is gitignored — never commit it)
cp .env.example .env
# Edit .env and fill in MIDSCENE_MODEL_BASE_URL / API_KEY / NAME / FAMILY

# 3. Check the model, then run the full suite. Setup starts the mock server on
#    port 3200, or uses one you already started with `pnpm start:web:mock:e2e`.
npm run check:model
npm test
```

`npm run check:model` runs `midscene-test model verify`. When it fails, it
prints a `curl` command that contains the API key, so do not paste its output
into an issue or chat.

### Selecting Cases

Tag filtering is controlled through environment variables (read in
`midscene.config.ts`):

```bash
# PoC stories only
MIDSCENE_INCLUDE_TAGS=poc npm test

# One topic (a case can carry multiple tags)
MIDSCENE_INCLUDE_TAGS=routines npm test

# Multiple tags are OR-combined, comma-separated
MIDSCENE_INCLUDE_TAGS=auth,settings npm test

# Exclude slow cases
MIDSCENE_EXCLUDE_TAGS=story npm test

# Adjust retries (default 2)
MIDSCENE_RETRY=0 npm test

# Headed mode for debugging
HEADLESS=false npm test
```

### Tag Conventions

| Tag | Meaning |
| --- | --- |
| `poc` | Accepted PoC storylines (AUTH-01, E2E-01/02/03) |
| `story` | Cross-page end-to-end storylines (slower) |
| `auth` / `chat` / `apps` / `sessions` / `routines` / `activity` / `people` / `files` / `settings` / `shell` / `global` | Functional topics |
| `zh` | Chinese-UI (i18n) cases |
| `mobile` | Narrow-viewport cases |

## Reports and Artifacts

- HTML reports: `midscene_run/report/`
- Machine-readable results: `.midscene/test-results/<runId>/summary.json`,
  with a Markdown digest `result.md` beside it
- All of them are covered by `.gitignore`.
- Each suite job uploads `midscene_run/` and `.midscene/` as
  `midscene-suite-<suite>`, including failed runs, and appends its
  `result.md` to the job Summary. The backend job also appends
  `backend-summary.md` (image revision and anomalies) and uploads only after
  its secret scan passes.
- The `publish` job copies each suite's HTML report to GitHub Pages under
  `runs/<run-id>/<suite>/`, keeps the last three runs, and links the reports
  that exist from its Summary. Pages publishes only the Midscene reports, not
  the container log.
- Pages publication is enabled for `rome-os/rome` on `main`. A fork can opt in
  by setting the Actions variable `MIDSCENE_PUBLISH_REPO` to its exact full
  repository name, then using manual dispatch. Set the dispatch input
  `publish_pages` to `false` to skip publication.
  A maintainer must select **Settings → Pages → Build and deployment → Source →
  GitHub Actions** in the publishing repository. The workflow does not enable
  or change the repository's Pages settings. If Pages configuration is
  unavailable, publication is skipped with a warning and reports remain
  available through Actions.

## GitHub Actions

The independent `midscene.yml` workflow runs both model-backed suites
nightly against the latest upstream `main` commit. Its daily schedule is
`0 6 * * *` (06:00 UTC / 14:00 Beijing), matching `nightly.yml`.
It does not depend on the ordinary CI or Nightly workflow, and pushes and pull
requests do not trigger it. The `mock` job runs first and the `backend` job
after it, because both share the Midscene endpoint's rate limit. The `backend`
job tests `zoolsher/rome:latest`, the image published from `main` twice a day.

Before changing this package, run `npm run typecheck` and a tagged subset of
cases locally; each suite job type-checks the package before its cases run.
See the
[CI design](../../docs/midscene-e2e-plan.md#4-ci-design-githubworkflowsmidsceneyml)
for the trust gates.

Manual `workflow_dispatch` runs both suites on upstream `main`; set `suite` to
`mock` or `backend` to run one. A fork owner may manually dispatch a fork
branch using that fork's model secrets.

## Authoring Conventions

1. Start every case with exactly one `app.open`. This resets the fixture state.
   Use `aiAct` for navigation within the case.
2. Give `aiAct` a user goal and enough context to choose the right control.
   Combine related clicks, typing, scrolling, and navigation into one task when
   they form one user intent.
3. Use `aiAssert` after each meaningful state change. Describe the visible
   outcome and quote stable UI text that separates success from nearby states.
4. Every case must contain at least one `aiAct` and one `aiAssert`. Do not
   use atomic AI nodes such as `aiTap` or other operational `app.*` nodes.
   `app.open` initializes the page, and `app.expectRenameConflict` checks the
   transient HTTP 409 response in FILE-03. Keep user interaction and visible
   outcomes in `aiAct` and `aiAssert`.
5. Use `wait` only for mock state that settles asynchronously. Do not use fixed
   waits as a substitute for an observable completion condition.
6. Keep a case focused on one user goal. Put multiple checkpoints in the same
   case only when they prove one stateful flow.
7. Use synthetic fixture data only. Never add real people, accounts, tokens, or
   chat content.
8. If a visual step fails, adjust the goal and visible checkpoint instead of
   adding a deterministic helper node.
