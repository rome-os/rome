# Rome × Midscene Visual E2E

Visual-driven end-to-end testing for Rome using
[Midscene](https://midscenejs.com/) YAML cases. Tests run against Rome's
**strict MSW E2E mode** (`pnpm start:web:mock:e2e` from the repository root): they never hit a real backend or use real
personal data. The browser only loads local synthetic fixtures. The Node-side
Midscene agent calls the configured model endpoint.

> The companion planning doc is
> [`docs/midscene-e2e-plan.md`](../../docs/midscene-e2e-plan.md) (test design,
> mock contract, CI execution design).

## How It Works

- Project setup starts the strict mock server, waits for readiness, and checks
  mock APIs and network isolation before running cases. Teardown closes the
  browser and the server started by this run. An existing server is reused
  and checked, but is not stopped. For a server started by setup, stdout and
  stderr go to `midscene_run/rome-devmock.log` and are included in the test
  artifact. Reused servers keep their existing output destination.
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
  blocks external HTTP and WebSocket traffic. Project setup checks both paths automatically. Strict E2E mode
  disables the backend proxy, and unmatched `/api` requests return 503 locally.
- Every case uses Midscene's `aiAct` for user interaction and `aiAssert` for
  visible outcomes. `app.open` provides the isolated starting route, and
  `wait` covers fixed mock settling time.
- The suite uses AI-native cases. Each case starts one isolated product
  goal. Related page states share a case only when they belong to that goal.
- YAML under `cases/` is the single source of truth for case definitions.
  Adding or renaming a case requires only its YAML change.
- The package registers `app.open` for isolated setup and
  `app.expectRenameConflict` for FILE-03's transient response. Run
  `npm run nodes` to generate a local node reference with their parameters.
- All cases live in `cases/**/*.yaml`, organized by suite file, with topic tags.

## Prerequisites

- Node.js 24 (the repo pins it via fnm: `eval "$(fnm env)" && fnm use 24`)
- Rome dependencies installed (`pnpm install` at the repo root)
- Credentials for the visual model Midscene uses (an OpenAI-compatible API)

## Running Locally

```bash
# 1. Install test dependencies (first time only)
cd tests/midscene
npm install
npx playwright install chromium

# 2. Configure model credentials (first time only; .env is gitignored — never commit it)
cp .env.example .env
# Edit .env and fill in MIDSCENE_MODEL_BASE_URL / API_KEY / NAME / FAMILY

# 3. Run the full suite (setup starts and checks the mock server)
npm test
```

### Model verification

`npm run check:model` invokes `midscene-test model verify`. It checks text
responses, image understanding, and AI locate using the configured models.
CI runs it before the visual cases. This command makes model API calls and
returns a nonzero exit code if verification fails.

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

# Adjust retries (default 2; CI also uses 2)
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
| `zh` | Chinese-UI (i18n) cases |
| `mobile` | Narrow-viewport cases |

## Reports and Artifacts

The workflow uses `@midscene/test@1.15.3`.
The lockfile is synchronized with this stable release. CI installs dependencies
with `npm install --strict-allow-scripts`.

- HTML reports: `midscene_run/report/`
- Machine-readable results: `.midscene/test-results/<runId>/summary.json`
- Markdown results: `.midscene/test-results/<runId>/result.md`
- These outputs are covered by `.gitignore`.
- Each run uploads one `midscene-results` artifact containing the original
  framework reports and mock server log. Pages downloads this artifact directly.
- The test job writes the native `result.md` case list and artifact download
  link to Actions Summary, omitting the artifact-relative HTML link.
- The Pages job prepares and deploys the site, then writes its online report
  link to a separate Summary block. If Pages fails or is skipped, the test
  results and artifact link remain available.
- Pages preserves the original HTML and assets at their relative paths. Each run
  has an index linking to its original report. Reports are not merged.
- Pages publication defaults on for runs with report artifacts, including
  manually dispatched fork runs. Pull requests never publish.
  A maintainer must select **Settings → Pages → Build and deployment → Source →
  GitHub Actions** in the publishing repository. The workflow does not enable
  or change the repository's Pages settings. If Pages configuration is
  unavailable, publication is skipped with a warning and reports remain
  available through Actions.
- Download reports from the workflow run's Artifacts section. Set
  `publish_pages` to `false` when only downloadable artifacts are needed.
- Pull requests do not trigger this workflow. The model-backed test job runs on the upstream `main` branch or by manual
  dispatch in a fork using that fork's model secrets.

## GitHub Actions

The independent `midscene.yml` workflow runs the full model-backed suite
nightly against the latest upstream `main` commit. Its daily schedule is
`0 6 * * *` (06:00 UTC / 14:00 Beijing), matching `nightly.yml`.
It does not depend on the ordinary CI or Nightly workflow, and pushes do not
trigger it. One visual test job runs all cases with `maxConcurrency: 1`.

Pull requests do not trigger this workflow. Mock network checks run in the
Midscene project setup before model-backed cases.

Manual `workflow_dispatch` runs the full suite on upstream `main`.
A fork owner may manually dispatch a fork branch using that fork's model
secrets. Reports are generated from the current run only.
Pages publication defaults on. Manual runs can disable it with `publish_pages`.
Runs across branches share a workflow concurrency group so history download
through Pages deployment is serialized. This also serializes test runs.

## Authoring Conventions

1. Start every case with exactly one `app.open`. This resets the fixture state.
   Use `aiAct` for navigation within the case.
2. Give `aiAct` a user goal and enough context to choose the right control.
   Combine related clicks, typing, scrolling, and navigation into one task when
   they form one user intent.
3. Use `aiAssert` after each meaningful state change. Describe the visible
   outcome and quote stable UI text that separates success from nearby states.
4. Every case must contain at least one `aiAct` and one `aiAssert`. Avoid
   atomic AI nodes such as `aiTap`. `app.open` initializes the page, and
   `app.expectRenameConflict` checks the transient HTTP 409 response in FILE-03.
   Keep user interaction and visible outcomes in `aiAct` and `aiAssert`.
5. Use `wait` only for mock state that settles asynchronously. Do not use fixed
   waits as a substitute for an observable completion condition.
6. Keep a case focused on one user goal. Put multiple checkpoints in the same
   case only when they prove one stateful flow.
7. Use synthetic fixture data only. Never add real people, accounts, tokens, or
   chat content.
8. Avoid other `app.*` nodes and the `deterministic-assist` tag. If a visual
   step fails, adjust the goal and visible checkpoint.

## Fork setup: yuyutaotao/rome

1. Enable workflows in the repository's **Actions** tab.
2. Under **Settings → Environments → Model**, configure the following values.
   The visual test job references this environment.

   | Setting | Type | Value |
   | --- | --- | --- |
   | `MIDSCENE_MODEL_API_KEY` | Secret | The visual model provider's API key |
   | `MIDSCENE_MODEL_BASE_URL` | Variable | An OpenAI-compatible API base URL reachable from GitHub-hosted runners |
   | `MIDSCENE_MODEL_NAME` | Variable | The provider's vision model name or endpoint ID |
   | `MIDSCENE_MODEL_FAMILY` | Variable | The model family, such as `doubao-seed` for Seed |

   Model variables take precedence over same-named secrets. Secrets remain
   supported for repositories that store all model settings there.

3. Select **Settings → Pages → Build and deployment → Source → GitHub Actions**.
4. Open **Actions → E2E Testing by Midscene → Run workflow** to run all cases.
   Set `publish_pages=false`
   if you only need downloadable artifacts.

Fork model runs require manual dispatch. The daily schedule runs model tests
only in `rome-os/rome` on `main`. Pull requests run checks without model secrets.
`GITHUB_TOKEN` is supplied by Actions. Rome backend credentials are unnecessary
because the browser uses mock fixtures.
