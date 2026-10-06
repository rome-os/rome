# Rome × Midscene Visual E2E

Visual-driven end-to-end testing for Rome using
[Midscene](https://midscenejs.com/) YAML cases. Tests run against Rome's
**strict MSW E2E mode** (`pnpm start:web:mock:e2e` from the repository root): they never hit a real backend or use real
personal data. The browser only loads local synthetic fixtures. The Node-side
Midscene agent calls the configured model endpoint.

> The companion planning doc is
> [`docs/midscene-e2e-plan.md`](../../docs/midscene-e2e-plan.md) (case catalog,
> mock contract, CI shard design).

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
- The collector checks every case name and shard against `case-manifest.json`
  and the documented catalog. Missing, renamed, or moved cases fail CI. Keep
  those two records independent of YAML so deleting or moving a case cannot
  silently change its expected result.
- The package registers `app.open` for isolated setup and
  `app.expectRenameConflict` for FILE-03's transient response. Run
  `npm run nodes` to generate a local node reference with their parameters.
- All cases live in `cases/**/*.yaml`, organized by suite file, with tags for
  shard and topic.

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

# One suite (a case can carry multiple tags)
MIDSCENE_INCLUDE_TAGS=routines npm test

# Multiple tags are OR-combined, comma-separated
MIDSCENE_INCLUDE_TAGS=auth,settings npm test

# Exclude slow cases
MIDSCENE_EXCLUDE_TAGS=story npm test

# Adjust retries (default 2; CI sets it per shard as needed)
MIDSCENE_RETRY=0 npm test

# Headed mode for debugging
HEADLESS=false npm test
```

### Tag Conventions

| Tag | Meaning |
| --- | --- |
| `poc` | Accepted PoC storylines (AUTH-01, E2E-01/02/03) |
| `story` | Cross-page end-to-end storylines (slower) |
| `auth` / `chat` / `apps` / `sessions` / `routines` / `activity` / `people` / `files` / `settings` / `shell` / `global` | Functional suites |
| `shard-N` | CI shard ownership (N=1…6), see the planning doc |
| `zh` | Chinese-UI (i18n) cases |
| `mobile` | Narrow-viewport cases |

## Reports and Artifacts

- HTML reports: `midscene_run/report/`
- Machine-readable results:
  `.midscene/test-results/<runId>/summary.json` (includes collection-error
  details)
- Both are covered by `.gitignore`.
- Every model-backed run uploads each shard report, including failed runs.
  Repositories with `MIDSCENE_PUBLISH_REPO` set to their full name also upload a
  combined `midscene-e2e-report` artifact. Each visual shard writes its own Markdown job
  Summary. The run Summary shows failed, not-run, and incomplete-shard results
  first; passed cases and their screenshots appear in a collapsed appendix.
  Midscene merges the six native Test reports into one report that lists every
  case. The configured repository publishes that report through GitHub Pages,
  so report links and images work from the Actions Summary. If the merge is
  incomplete, it still publishes the available shard reports without a broken
  combined-report link.

## GitHub Actions

The independent `midscene.yml` workflow runs the full model-backed suite
nightly against the latest upstream `main` commit. Its daily schedule is
`0 6 * * *` (06:00 UTC / 14:00 Beijing), matching `nightly.yml`.
It does not depend on the ordinary CI or Nightly workflow, and pushes do not
trigger it. The six visual shards run serially with `max-parallel: 1`.

Path-filtered pull requests run only the secret-free harness and mock-browser
boundary checks. They never receive billable model credentials or run the
visual shard matrix. See the [CI design](../../docs/midscene-e2e-plan.md#4-ci-design-githubworkflowsmidsceneyml)
for the path set and trust gates.

Manual `workflow_dispatch` runs the full suite on upstream `main`.
A fork owner may manually dispatch a fork branch using that fork's model
secrets. Set the optional `report_source_run_id` input to an existing run ID
to rebuild its reports from shard artifacts without new model calls.
Report publishing still requires the repository to match
`MIDSCENE_PUBLISH_REPO`.

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
