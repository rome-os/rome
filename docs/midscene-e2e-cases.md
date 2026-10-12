# Rome Midscene E2E Cases

> Evaluation target: [Rome](https://github.com/rome-os/rome)
>
The YAML files in [tests/midscene/cases](../tests/midscene/cases/) are the
single source of truth for case names, tags, and steps. Add, rename, or remove
cases there without maintaining a separate inventory.

## Suite shape

Every case starts with `app.open`, uses `aiAct` for user interaction, and uses
`aiAssert` for its visible outcome. Navigation checks rely on visible page
state, not the browser address bar.

Run `npm run collect` from `tests/midscene` to parse YAML and check custom
nodes, duplicate names, and case conventions without starting a browser or
calling a model. The generated Midscene report lists the executed cases.

## Execution contract

- MSW rejects external HTTP requests. A BrowserContext guard blocks external
  HTTP and WebSocket traffic.
- Model calls run from the Node-side Midscene agent, not from the page.
- Every case gets a fresh BrowserContext, so MSW state is isolated between
  cases while client-side navigation within one case preserves mock writes.
- Pull requests do not trigger the workflow. The model-backed
  test job runs on the upstream `main` branch or by manual dispatch in a fork
  using that fork's model secrets.
- Every model-backed run uploads its test reports, including failed runs.
  A repository with `MIDSCENE_PUBLISH_REPO` set to its full name also publishes
  Summary and recent reports through GitHub Pages. Case titles link to the
  original HTML report, which contains execution details and existing screenshots.

## Local run

Project setup starts or reuses the mock server and checks network isolation.
Run the suite from the repository root:

```bash
cd tests/midscene
npm install --strict-allow-scripts
npx playwright install chromium
MIDSCENE_RETRY=0 HEADLESS=true npm test
```

Use `MIDSCENE_INCLUDE_TAGS=chat` to run only chat cases. Model settings belong in
the untracked `tests/midscene/.env`. Never commit credentials.
