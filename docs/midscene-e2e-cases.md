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

The secret-free collector checks each case name against
`tests/midscene/case-manifest.json` and this catalog. Adding, deleting, or
renaming a case requires updating both records.

## Case catalog

| ID | Case |
| --- | --- |
| CHAT-01 | Draft and clear a message from the home composer |
| CHAT-02 | Open the skill picker after a failed send |
| CHAT-03 | Open the agent mention picker |
| CHAT-04 | Inspect a successful execution trace |
| CHAT-05 | Draft an answer in an unanswered question card |
| CHAT-06 | Collapse the architecture diagram in a built-app reply |
| CHAT-07 | Open a linked market report from a recorded conversation |
| CHAT-08 | Choose a tone on the live question card |
| CHAT-09 | Reject the plumber approval card |
| APPS-01 | Search the installed-app catalog |
| APPS-02 | Disable an app from its tile menu |
| APPS-03 | Open Issue Triage from its details page |
| E2E-03 | Open a built app from Chat |
| SES-01 | Search for a missing session |
| SES-02 | Open the session filter panel |
| SES-03 | Open a channel session detail |
| ROUT-01 | Open the routine calendar |
| ROUT-02 | Filter the routine list |
| E2E-01 | Enable a proposed routine from Chat |
| E2E-02 | Approve a pending outbound message |
| ACT-03 | Review requests and inspect an accepted webhook payload |
| FILE-01 | Search the project tree |
| FILE-02 | Open a project file |
| FILE-03 | Handle a duplicate project-file rename |
| FILE-04 | Open a Memory file |
| PPL-01 | Open the people directory |
| PPL-02 | Filter a person timeline by channel |
| SET-01 | Open the appearance-mode choices |
| SET-02 | Open connection details |
| SET-03 | Inspect channel activation settings |
| SET-04 | Open advanced developer settings |
| AUTH-01 | Inspect the authenticated account identity |
| AUTH-02 | Login validation and failed submission preserve the form |
| RAPP-01 | Inspect recent Issue Triage activity |
| RAPP-02 | Inspect a completed Code Review record |
| RAPP-03 | Inspect a completed Stock Daily report |
| SHELL-02 | Search global chat history |
| SHELL-03 | Open the mobile navigation drawer |

The case names above match the executable YAML. Run
`npm run collect` from `tests/midscene` to validate the catalog manifest.

## Execution contract

- MSW rejects external HTTP requests. A BrowserContext guard blocks external
  HTTP and WebSocket traffic.
- Model calls run from the Node-side Midscene agent, not from the page.
- Every case gets a fresh BrowserContext, so MSW state is isolated between
  cases while client-side navigation within one case preserves mock writes.
- CI pull requests run secret-free harness and mock-browser boundary checks. The model-backed
  test job runs on the upstream `main` branch or by manual dispatch in a fork
  using that fork's model secrets.
- Every model-backed run uploads its test reports, including failed runs.
  A repository with `MIDSCENE_PUBLISH_REPO` set to its full name also publishes
  the combined Summary and recent reports through GitHub Pages. Each case has
  a screenshot and an exact report-step link when available. If the native
  merge is incomplete, the test reports remain available and the Summary
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

Use `MIDSCENE_INCLUDE_TAGS=chat` to run only chat cases. Model settings belong in
the untracked `tests/midscene/.env`. Never commit credentials.
