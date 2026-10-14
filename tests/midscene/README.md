# Rome × Midscene Visual E2E

Visual-driven end-to-end testing for Rome using
[Midscene](https://midscenejs.com/) YAML cases, in two suites:

- **mock** (`cases/`, `midscene.config.ts`): runs against Rome's **strict MSW
  E2E mode** (`pnpm start:web:mock:e2e` from the repository root). It never hits
  a real backend or uses real personal data. The browser only loads local
  synthetic fixtures.
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

- `midscene.config.ts` launches Playwright Chromium with a **fresh
  BrowserContext per case**: in-memory MSW state resets with the context, so
  every case starts from the same fixtures.
- An init script seeds two localStorage contracts only when the app has no
  stored value yet (it does not overwrite a case's own choice, so a language
  switch or sidebar edit persists across navigation):
  - `rome.lang = en`: pins the English UI (avoids locale interference on a
    Chinese CI machine);
  - `rome-sidebar-pins`: expands every built-in sidebar entry (the mock user
    pins only Apps/Chat/Projects by default).
- The strict E2E worker rejects external HTTP requests. A BrowserContext guard also
  blocks external HTTP and WebSocket traffic. Run `npm run check:browser-boundary`
  while the strict mock server is running to check both paths. Strict E2E mode
  disables the backend proxy, and unmatched `/api` requests return 503 locally.
- Every case uses Midscene's `aiAct` for user interaction and `aiAssert` for
  visible outcomes. `app.open` provides the isolated starting route, and
  `wait` covers fixed mock settling time.
- The suite contains 38 AI-native cases. Each case starts one isolated product
  goal. Related page states share a case only when they belong to that goal.
- The collector checks every case name and suite against `case-manifest.json`
  and the documented catalog. Missing, renamed, or moved cases fail CI. Keep
  those two records independent of YAML so deleting or moving a case cannot
  silently change its expected result.
- The package registers `app.open` for isolated setup and
  `app.expectRenameConflict` for FILE-03's transient response. Run
  `npm run nodes` to generate a local node reference with their parameters.
- All mock cases live in `cases/**/*.yaml`, organized by topic file, with a
  `mock` suite tag and topic tags.

## Prerequisites

- Node.js 24 (the repo pins it via fnm: `eval "$(fnm env)" && fnm use 24`)
- Rome dependencies installed (`pnpm install` at the repo root)
- Credentials for the visual model Midscene uses (an OpenAI-compatible API)

## Running Locally

```bash
# 1. Start strict Rome E2E mock mode at the repository root
pnpm start:web:mock:e2e
# Served at http://localhost:3200; logs default to /tmp/rome-devmock.log

# 2. Install test dependencies (first time only)
cd tests/midscene
npm install
npx playwright install chromium

# 3. Configure model credentials (first time only; .env is gitignored — never commit it)
cp .env.example .env
# Edit .env and fill in MIDSCENE_MODEL_BASE_URL / API_KEY / NAME / FAMILY

# 4. Run the full suite
npm test
```

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
| `mock` / `backend` | Suite: exactly one per case, matching `case-manifest.json` |
| `zh` | Chinese-UI (i18n) cases |
| `mobile` | Narrow-viewport cases |

## Reports and Artifacts

- HTML reports: `midscene_run/report/`
- Machine-readable results:
  `.midscene/test-results/<runId>/summary.json` (includes collection-error
  details)
- Both are covered by `.gitignore`.
- Each suite job uploads its report as `midscene-suite-<suite>`, and the run
  uploads a combined
  `midscene-e2e-report` artifact, including failed runs. A read-only job writes
  results immediately after aggregation, without waiting for Pages approval or deployment.
  This Summary shows total, passed, failed, and not-run counts with artifact
  downloads, without case tables or empty screenshot columns. A second read-only
  job adds publication status after Pages finishes. Only a successful deployment
  adds the complete case tables with verified report links and screenshots.
  Failed, not-run, and incomplete-suite results appear first. Passed cases appear
  in a collapsed appendix. The first Summary remains
  available if publication waits for approval or the run is cancelled during that wait.
- Midscene merges the suites' native Test reports into one report that lists
  every case. The combined artifact includes that report, available suite reports,
  screenshots, and machine-readable results. An incomplete merge still saves
  available diagnostics and fails the aggregation job.
- Pages publication is enabled for `rome-os/rome` on `main`. A fork can opt in
  by setting the Actions variable `MIDSCENE_PUBLISH_REPO` to its exact full
  repository name, then using manual dispatch. Pull requests never publish.
  A maintainer must select **Settings → Pages → Build and deployment → Source →
  GitHub Actions** in the publishing repository. The workflow does not enable
  or change the repository's Pages settings. If Pages configuration is
  unavailable, publication is skipped with a warning and reports remain
  available through Actions.
- After a successful Pages deployment, the same Summary includes a visible
  Markdown link to the combined native Midscene Test report. Case names and
  screenshot thumbnails open their exact steps in the native suite reports.
  If Pages fails or is skipped, the Summary shows result counts and artifact
  links. If aggregation fails, the final job recovers available suite data and
  reports missing results. Report-only recovery validates the source run before
  downloading its artifacts. Partial reports keep available suite links without
  a broken combined-report link.
- To rebuild a report without new model calls, manually dispatch the workflow
  with `report_source_run_id` set to a completed Midscene run whose suite
  artifacts have not expired. Sources and retained Pages history must come
  from the same repository: upstream `main` scheduled runs, pushes, or manual dispatches,
  or a fork's manual dispatches. Pull-request artifacts are rejected.
  On upstream, dispatch `main` to also publish. Set the dispatch input
  `publish_pages` to `false` to verify the report job and its Actions Summary
  without a Pages deployment. Scheduled upstream runs also publish when Pages is available.
- The backend suite's report also carries its container log and a
  `backend-summary.md` (image revision and anomalies), which the run Summary
  includes. Pages publishes only the Midscene reports, not the container log.
- Pull requests do not run this workflow. The model-backed suite jobs run on
  the upstream `main` branch or by manual dispatch in a fork using that fork's
  model secrets.

## GitHub Actions

The independent `midscene.yml` workflow runs both model-backed suites
nightly against the latest upstream `main` commit. Its daily schedule is
`0 6 * * *` (06:00 UTC / 14:00 Beijing), matching `nightly.yml`.
It does not depend on the ordinary CI or Nightly workflow, and pushes do not
trigger it. The `mock` job runs first and the `backend` job after it, because
both share the Midscene endpoint's rate limit. The `backend` job tests
`zoolsher/rome:latest`, the image published from `main` twice a day.

Pull requests do not trigger the workflow. Before changing this package, run
`npm run typecheck && npm run collect && npm run test:summary` locally; the
nightly `harness-validation` job runs the same checks. See the
[CI design](../../docs/midscene-e2e-plan.md#4-ci-design-githubworkflowsmidsceneyml)
for the trust gates.

Manual `workflow_dispatch` runs both suites on upstream `main`; set `suite` to
`mock` or `backend` to run one. A fork owner may manually dispatch a fork
branch using that fork's model secrets. Set the optional `report_source_run_id`
input to an existing run ID to rebuild its reports from suite artifacts without
new model calls, with `suite` matching that run.
Pages publication is enabled upstream. Fork publication requires an exact
`MIDSCENE_PUBLISH_REPO` match.

## Authoring Conventions

1. Start every case with exactly one `app.open`. This resets the fixture state.
   Use `aiAct` for navigation within the case.
2. Give `aiAct` a user goal and enough context to choose the right control.
   Combine related clicks, typing, scrolling, and navigation into one task when
   they form one user intent.
3. Use `aiAssert` after each meaningful state change. Describe the visible
   outcome and quote stable UI text that separates success from nearby states.
4. Every case must contain at least one `aiAct` and one `aiAssert`. The
   collection check rejects atomic AI nodes such as `aiTap` and operational
   `app.*` nodes. `app.open` initializes the page, and
   `app.expectRenameConflict` checks the transient HTTP 409 response in FILE-03.
   Keep user interaction and visible outcomes in `aiAct` and `aiAssert`.
5. Use `wait` only for mock state that settles asynchronously. Do not use fixed
   waits as a substitute for an observable completion condition.
6. Keep a case focused on one user goal. Put multiple checkpoints in the same
   case only when they prove one stateful flow.
7. Use synthetic fixture data only. Never add real people, accounts, tokens, or
   chat content.
8. The collector rejects other `app.*` nodes and the `deterministic-assist`
   tag. If a visual step fails, adjust the goal and visible checkpoint.
