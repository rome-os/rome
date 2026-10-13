# Rome Midscene E2E Cases

> Evaluation target: [Rome](https://github.com/rome-os/rome)
>
> Cases live in `tests/midscene/cases/` and run against the local MSW mock
> build with synthetic fixtures. The 38-case suite passes locally with the
> Seed model and no case retries. The linked
> [Actions run 35816486576](https://github.com/quanru/rome/actions/runs/35816486576)
> covers a separate remote revision, not this local change.

## Suite shape

The suite contains 38 AI-native cases in 15 YAML files. Every case starts with
`app.open`, uses `aiAct` for user interaction, and uses `aiAssert` for its
visible outcome. Navigation checks rely on visible page state, not the browser
address bar.

The secret-free collector checks each case name and shard against
`tests/midscene/case-manifest.json` and this catalog. Deleting, renaming, or
moving a case fails CI.

| Shard | Cases | Main coverage |
| --- | ---: | --- |
| shard-1 | 5 | Chat composer, menus, send failure, traces, question card |
| shard-2 | 8 | Apps, rich chat cards, E2E-03 |
| shard-3 | 7 | Sessions, routines, E2E-01 and E2E-02 |
| shard-4 | 7 | Activity, files, memory, people |
| shard-5 | 6 | Settings, auth, shell navigation |
| shard-6 | 5 | Recorded apps, global search, mobile navigation |
| **Total** | **38** | |

## Case catalog

| ID | Case | Shard |
| --- | --- | --- |
| CHAT-01 | Draft and clear a message from the home composer | shard-1 |
| CHAT-02 | Open the skill picker after a failed send | shard-1 |
| CHAT-03 | Open the agent mention picker | shard-1 |
| CHAT-04 | Inspect a successful execution trace | shard-1 |
| CHAT-05 | Draft an answer in an unanswered question card | shard-1 |
| CHAT-06 | Collapse the architecture diagram in a built-app reply | shard-2 |
| CHAT-07 | Open a linked market report from a recorded conversation | shard-2 |
| CHAT-08 | Choose a tone on the live question card | shard-2 |
| CHAT-09 | Reject the plumber approval card | shard-2 |
| APPS-01 | Search the installed-app catalog | shard-2 |
| APPS-02 | Disable an app from its tile menu | shard-2 |
| APPS-03 | Open Issue Triage from its details page | shard-2 |
| E2E-03 | Open a built app from Chat | shard-2 |
| SES-01 | Search for a missing session | shard-3 |
| SES-02 | Open the session filter panel | shard-3 |
| SES-03 | Open a channel session detail | shard-3 |
| ROUT-01 | Open the routine calendar | shard-3 |
| ROUT-02 | Filter the routine list | shard-3 |
| E2E-01 | Enable a proposed routine from Chat | shard-3 |
| E2E-02 | Approve a pending outbound message | shard-3 |
| ACT-03 | Review requests and inspect an accepted webhook payload | shard-4 |
| FILE-01 | Search the project tree | shard-4 |
| FILE-02 | Open a project file | shard-4 |
| FILE-03 | Handle a duplicate project-file rename | shard-4 |
| FILE-04 | Open a Memory file | shard-4 |
| PPL-01 | Open the people directory | shard-4 |
| PPL-02 | Filter a person timeline by channel | shard-4 |
| SET-01 | Open the appearance-mode choices | shard-5 |
| SET-02 | Open connection details | shard-5 |
| SET-03 | Inspect channel activation settings | shard-5 |
| SET-04 | Open advanced developer settings | shard-5 |
| AUTH-01 | Inspect the authenticated account identity | shard-5 |
| AUTH-02 | Login validation and failed submission preserve the form | shard-5 |
| RAPP-01 | Inspect recent Issue Triage activity | shard-6 |
| RAPP-02 | Inspect a completed Code Review record | shard-6 |
| RAPP-03 | Inspect a completed Stock Daily report | shard-6 |
| SHELL-02 | Search global chat history | shard-6 |
| SHELL-03 | Open the mobile navigation drawer | shard-6 |

The case names and shard assignments above match the executable YAML. Run
`npm run collect` from `tests/midscene` to validate the catalog manifest.

## Backend suite

The backend suite runs against a real Rome container built from the
production image, with a real model. Its cases live in
`tests/midscene/backend/cases/`, carry the `backend` tag, and are listed in
`tests/midscene/backend/case-manifest.json`. They run in file order against
one instance, because BE-01 creates the account that BE-02 signs in with.

| ID | Case | Shard |
| --- | --- | --- |
| BE-01 | Finish first-run onboarding with a connected model | backend |
| BE-02 | Write a project file and have Rome read it back | backend |

Assertions check page state and a per-run token, never model wording. Each
run also reports anomalies independently of the case results: error-level
container log lines, browser console and page errors, failed requests, and
HTTP responses of 400 or more. Unlike the mock suite, the browser has no
network guard, so CDN assets load as they do for a guardian.
`tests/midscene/backend/known-noise.json` lists the expected entries, each
with its reason.

## Execution contract

- MSW rejects external HTTP requests. A BrowserContext guard blocks external
  HTTP and WebSocket traffic.
- Model calls run from the Node-side Midscene agent, not from the page.
- Every case gets a fresh BrowserContext, so MSW state is isolated between
  cases while client-side navigation within one case preserves mock writes.
- CI pull requests run secret-free harness and mock-browser boundary checks. The six model-backed
  shards run on the upstream `main` branch or by manual dispatch in a fork
  using that fork's model secrets.
- Every model-backed run uploads its shard reports, including failed runs.
  A repository with `MIDSCENE_PUBLISH_REPO` set to its full name also publishes
  the combined Summary and recent reports through GitHub Pages. Each case has
  a screenshot and an exact report-step link when available. If the native
  merge is incomplete, the shard reports remain available and the Summary
  does not link to a missing combined report.

## Local run

Start the strict E2E mock build from the repository root:

```bash
pnpm start:web:mock:e2e
```

Then run the suite from another shell:

```bash
cd tests/midscene
npm ci --strict-allow-scripts
npx playwright install chromium
MIDSCENE_RETRY=0 HEADLESS=true npm test
```

Use `MIDSCENE_INCLUDE_TAGS=shard-2` to run one shard. Model settings belong in
the untracked `tests/midscene/.env`. Never commit credentials.

To run the backend suite, build or pull an image, then run the script from the
repository root. It starts a throwaway instance on `127.0.0.1:8090` with empty
volumes, runs the cases, writes the container log and the anomaly report to
`tests/midscene/midscene_run/backend/`, scans that output for the model
secrets, and deletes the instance:

```bash
ROME_E2E_IMAGE=yunfanye/rome:latest \
ROME_E2E_ANTHROPIC_ENV_FILE=path/to/custom-env.json \
tests/midscene/backend/run.sh
```

The model environment file is the JSON that **Settings → AI Tools → Other API
providers → Custom environment** accepts:
`{ "env": { "ANTHROPIC_AUTH_TOKEN": "…", … } }`. The suite stores it through
the same API before onboarding reaches the connect-AI step. No step types it,
so it never appears in a screenshot or a report. Set `ROME_E2E_KEEP=1` to keep
the instance running after the cases.
