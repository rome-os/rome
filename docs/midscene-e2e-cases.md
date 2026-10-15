# Rome Midscene E2E Cases

> Evaluation target: [Rome](https://github.com/rome-os/rome)
>
> Cases live in `tests/midscene/cases/` and run against the local MSW mock
> build with synthetic fixtures. The 38-case suite passes locally with the
> Seed model and no case retries. The linked
> [Actions run 35816486576](https://github.com/quanru/rome/actions/runs/35816486576)
> covers a separate remote revision, not this local change.

## Suite shape

The cases form two suites. Each suite is one Midscene project, one CI job, and
one report artifact.

| Suite | Cases | Target | Main coverage |
| --- | ---: | --- | --- |
| mock | 38 | The strict MSW mock build with synthetic fixtures | Chat, apps, sessions, routines, files, people, settings, shell |
| backend | 2 | A real Rome container from the published image, with a real model | First-run onboarding, a project file read back by Rome |

Every case starts with `app.open`, uses `aiAct` for user interaction, uses
`aiAssert` for its visible outcome.
Navigation checks rely on visible page state, not the browser address bar.

Each suite's config selects its cases by path: `midscene.config.ts` reads
`tests/midscene/cases/`, and `midscene.backend.config.ts` reads
`tests/midscene/backend/cases/`.

## Case catalog

| ID | Case | Suite |
| --- | --- | --- |
| CHAT-01 | Draft and clear a message from the home composer | mock |
| CHAT-02 | Open the skill picker after a failed send | mock |
| CHAT-03 | Open the agent mention picker | mock |
| CHAT-04 | Inspect a successful execution trace | mock |
| CHAT-05 | Draft an answer in an unanswered question card | mock |
| CHAT-06 | Collapse the architecture diagram in a built-app reply | mock |
| CHAT-07 | Open a linked market report from a recorded conversation | mock |
| CHAT-08 | Choose a tone on the live question card | mock |
| CHAT-09 | Reject the plumber approval card | mock |
| APPS-01 | Search the installed-app catalog | mock |
| APPS-02 | Disable an app from its tile menu | mock |
| APPS-03 | Open Issue Triage from its details page | mock |
| E2E-03 | Open a built app from Chat | mock |
| SES-01 | Search for a missing session | mock |
| SES-02 | Open the session filter panel | mock |
| SES-03 | Open a channel session detail | mock |
| ROUT-01 | Open the routine calendar | mock |
| ROUT-02 | Filter the routine list | mock |
| E2E-01 | Enable a proposed routine from Chat | mock |
| E2E-02 | Approve a pending outbound message | mock |
| ACT-03 | Review requests and inspect an accepted webhook payload | mock |
| FILE-01 | Search the project tree | mock |
| FILE-02 | Open a project file | mock |
| FILE-03 | Handle a duplicate project-file rename | mock |
| FILE-04 | Open a Memory file | mock |
| PPL-01 | Open the people directory | mock |
| PPL-02 | Filter a person timeline by channel | mock |
| SET-01 | Open the appearance-mode choices | mock |
| SET-02 | Open connection details | mock |
| SET-03 | Inspect channel activation settings | mock |
| SET-04 | Open advanced developer settings | mock |
| AUTH-01 | Inspect the authenticated account identity | mock |
| AUTH-02 | Login validation and failed submission preserve the form | mock |
| RAPP-01 | Inspect recent Issue Triage activity | mock |
| RAPP-02 | Inspect a completed Code Review record | mock |
| RAPP-03 | Inspect a completed Stock Daily report | mock |
| SHELL-02 | Search global chat history | mock |
| SHELL-03 | Open the mobile navigation drawer | mock |

The case names and suite assignments above match the executable YAML.

## Backend suite

The backend suite runs against a real Rome container started from the
published image, with a real model. Its cases live in
`tests/midscene/backend/cases/`. They share one
instance and run in path order, because ONBOARD-01 creates the account that
PROJECT-01 signs in with. Each file is named for what it tests, and its
numeric prefix fixes that order: `01-onboarding.yaml` holds ONBOARD-01, and
`02-project-files.yaml` holds PROJECT-01.

| ID | Case | Suite |
| --- | --- | --- |
| ONBOARD-01 | Finish first-run onboarding with a connected model | backend |
| PROJECT-01 | Write a project file and have Rome read it back | backend |

Assertions check page state and a per-run token, never model wording. Each
run also reports anomalies independently of the case results: error-level
container log lines, browser console and page errors, failed requests, and
HTTP responses of 400 or more. Unlike the mock suite, the browser has no
network guard, so CDN assets load as they do for a guardian.
`tests/midscene/backend/known-noise.json` lists the expected entries, each
with its reason.

## Execution contract

- In the mock suite, MSW rejects external HTTP requests and a BrowserContext
  guard blocks external HTTP and WebSocket traffic. Every case gets a fresh
  BrowserContext, so MSW state is isolated between cases while client-side
  navigation within one case preserves mock writes.
- Model calls run from the Node-side Midscene agent, not from the page.
- Pull requests do not run the Midscene workflow. The two suite jobs, `mock`
  and then `backend`, run on the upstream `main` branch or by manual dispatch
  in a fork using that fork's model secrets.
- Each suite job uploads its report as `midscene-suite-<suite>`, including
  failed runs, and writes Midscene's native result to its job Summary. The
  upstream `main` branch, or a fork whose `MIDSCENE_PUBLISH_REPO` is its full
  name, also publishes both HTML reports through GitHub Pages and links them
  from the `publish` job Summary.

## Local run

Run the mock suite from `tests/midscene`. Project setup starts the strict E2E
mock build on port 3200, or uses one already running there:

```bash
cd tests/midscene
npm ci --strict-allow-scripts
npx playwright install chromium
MIDSCENE_RETRY=0 HEADLESS=true npm test
```

Use `MIDSCENE_INCLUDE_TAGS=files` to run one topic. Model settings belong in
the untracked `tests/midscene/.env`. Never commit credentials.

To run the backend suite, pull an image, then run the script from the
repository root. It starts a throwaway instance on `127.0.0.1:8090` with empty
volumes, runs the cases, writes the container log and the anomaly report to
`tests/midscene/midscene_run/backend/`, scans that output for the model
secrets, and deletes the instance:

```bash
ROME_E2E_IMAGE=zoolsher/rome:latest \
ROME_E2E_ANTHROPIC_ENV_FILE=path/to/custom-env.json \
tests/midscene/backend/run.sh
```

The model environment file is the JSON that **Settings → AI Tools → Other API
providers → Custom environment** accepts:
`{ "env": { "ANTHROPIC_AUTH_TOKEN": "…", … } }`. The suite stores it through
the same API before onboarding reaches the connect-AI step. No step types it,
so it never appears in a screenshot or a report. Set `ROME_E2E_KEEP=1` to keep
the instance running after the cases.
