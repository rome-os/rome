# Rome Midscene E2E Cases

> Evaluation target: [Rome](https://github.com/rome-os/rome)
>
> Cases live in `tests/midscene/cases/` and run against the local MSW mock
> build with synthetic fixtures. The 38-case suite passed locally without case
> retries and passed in the fork's six remote shards:
> [Actions run 35816486576](https://github.com/quanru/rome/actions/runs/35816486576).

## Suite shape

The suite contains 38 AI-native cases in 15 YAML files. Every case starts with
`app.open`, uses `aiAct` for user interaction, and uses `aiAssert` for its
visible outcome. A small number of cases tagged `deterministic-assist` also use
targeted `app.*` nodes for state that cannot be read reliably from one
screenshot.

The secret-free collector validates the expected total and per-shard manifest,
so deleting or moving a case without deliberately updating the manifest fails
CI.

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
| CHAT-02 | Exercise composer pickers and the failed-send state | shard-1 |
| CHAT-03 | Preserve a draft after a failed send in an existing conversation | shard-1 |
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
| SHELL-02 | Open global chat search | shard-6 |
| SHELL-03 | Open the mobile navigation drawer | shard-6 |

The case names and shard assignments above match the executable YAML. Run
`npm run collect` from `tests/midscene` to validate the catalog manifest.

## Execution contract

- Browser requests are limited to `ROME_E2E_BASE_URL`. The BrowserContext
  request guard aborts unexpected CDN or third-party requests.
- Model calls run from the Node-side Midscene agent, not from the page.
- Every case gets a fresh BrowserContext, so MSW state is isolated between
  cases while client-side navigation within one case preserves mock writes.
- CI pull requests run only secret-free harness validation. The six model-backed
  shards run on the upstream `main` branch or by manual dispatch in a fork
  using that fork's model secrets.
- The `quanru/rome` fork uploads each shard's native report and publishes a
  Summary table for abnormal cases, followed by a collapsed appendix of passed
  cases. Each case has a screenshot and an exact report-step link when available.
- The upstream repository runs the cases without uploading reports or
  publishing the Summary.

## Local run

Start the mock build from the repository root:

```bash
pnpm start:web:mock
```

Then run the suite from another shell:

```bash
cd tests/midscene
npm ci
npx playwright install chromium
MIDSCENE_RETRY=0 HEADLESS=true npm test
```

Use `MIDSCENE_INCLUDE_TAGS=shard-2` to run one shard. Model settings belong in
the untracked `tests/midscene/.env`. Never commit credentials.
