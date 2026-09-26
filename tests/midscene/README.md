# Rome × Midscene Visual E2E

Visual-driven end-to-end testing for Rome using
[Midscene](https://midscenejs.com/) YAML cases. Tests run against Rome's
**MSW mock mode** (`pnpm dev:mock`): they never hit a real backend or use real
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
- A BrowserContext request guard aborts every browser request outside
  `ROME_E2E_BASE_URL`. Recorded apps cannot add hidden CDN dependencies.
- Every case uses Midscene's `aiAct` for user interaction and `aiAssert` for
  visible outcomes. `app.open` provides the isolated starting route, and
  `wait` covers fixed mock settling time.
- The suite contains 38 AI-native cases. Each case starts one isolated product
  goal. Related page states share a case only when they belong to that goal.
- The collector validates a 38-case per-shard manifest. A missing or moved case
  fails the secret-free validation job.
- The package also registers focused deterministic nodes:
  `app.open`, `app.expectUrl`, `app.expectResponse`, `app.clickByLabel`, `app.expectTexts`,
  `app.scrollTextIntoView`, and `app.pressKey`. Run `npm run nodes` to generate
  a local node reference with their parameters.
- All cases live in `cases/**/*.yaml`, organized by suite file, with tags for
  shard and topic.

## Prerequisites

- Node.js 24 (the repo pins it via fnm: `eval "$(fnm env)" && fnm use 24`)
- Rome dependencies installed (`pnpm install` at the repo root)
- Credentials for the visual model Midscene uses (an OpenAI-compatible API)

## Running Locally

```bash
# 1. Start Rome mock mode (at the repo root or in packages/web)
pnpm dev:mock
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
| `deterministic-assist` | AI-native journey with a narrowly scoped deterministic helper for a documented visual-model limitation |

## Reports and Artifacts

- HTML reports: `midscene_run/report/`
- Machine-readable results:
  `.midscene/test-results/<runId>/summary.json` (includes collection-error
  details)
- Both are covered by `.gitignore`.
- Runs in `quanru/rome` upload each shard and a combined
  `midscene-e2e-report` artifact. Its `index.html` contains the overall Summary,
  model names, shard counts, case results, durations, screenshots, and links to
  exact steps in the native Midscene reports. The fork publishes the HTML
  through GitHub Pages so links and images work from the Actions run Summary.
  The Actions Summary shows failed, not-run, and incomplete-shard results first;
  passed cases and their screenshots appear in a collapsed appendix.
- Runs in `rome-os/rome` execute the cases without uploading reports or
  publishing a Summary or GitHub Pages site.
- Pull requests run only the secret-free harness validation job. The
  model-backed shard matrix runs on the upstream `main` branch or by manual
  dispatch in a fork using that fork's model secrets.

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
   `app.*` nodes. `app.expectUrl` is allowed because the model cannot see the
   browser address bar. A case tagged `deterministic-assist` may use only the
   allowlisted helpers for a confirmed visual-model limitation; keep the user
   interaction and visible outcome covered by `aiAct` and `aiAssert`.
5. Use `wait` only for mock state that settles asynchronously. Do not use fixed
   waits as a substitute for an observable completion condition.
6. Keep a case focused on one user goal. Put multiple checkpoints in the same
   case only when they prove one stateful flow.
7. Use synthetic fixture data only. Never add real people, accounts, tokens, or
   chat content.
8. Keep deterministic nodes as local debugging tools. A committed exception
   must use the `deterministic-assist` tag and explain the visual limitation in
   the case or pull request.
