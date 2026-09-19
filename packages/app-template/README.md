# app-template

Static asset package: the directory trees under `template/` and `workflow/` are what `app_management { op: "create", appId }` copies into `~/.rome/<profile>/projects/apps/<appId>/` as the starting point for a new Rome app.

## Layout

```
template/
  app.yaml                  # manifest with __APP_ID__ / __APP_NAME__ placeholders
  README.md                 # App Store readme body (product copy, not tech docs)
  .rome_store/
    rome_store.yaml         # Rome Cloud store metadata sidecar
    assets/                 # optional store-only images / videos
  package.json              # depends on @rome-os/{app-runtime,app-web-sdk,ui}
  drizzle.config.ts
  actions/hello/            # one trivial action
  actions/ask-agent/        # reference: invoke an agent via summon (opt-in)
  api/index.ts              # metadata + runAction examples (run-hello, ask)
  db/{schema,repositories,migrations/}
  web/                      # React entry importing @rome-os/ui primitives
  skills/                   # empty

workflow/
  README.md                 # workflow-focused App Store readme body
  .rome_store/              # same Rome Cloud metadata sidecar shape
  src/workflow/             # runWorkflow definition + context types
  src/actions/run/          # one action that executes the workflow
```

## Placeholders

Two tokens, replaced verbatim during copy:

- `__APP_ID__` — raw app id (e.g. `my-app`)
- `__APP_NAME__` — display name derived from the id (e.g. `My App` for `my-app`); used for the top-level `app.yaml#name` that appears in the app dashboard, plus web labels.

Both contents and path segments are substituted, though no path segments contain placeholders today.

## Editing the template

Just edit files under `template/` or `workflow/`. They are not compiled. The scaffold copies the directory verbatim into the author's app source tree.

When adding a feature here:

- Keep it minimal and working — the template is the agent's first impression of "what a Rome app looks like."
- Any code that references `@rome-os/app-runtime`, `@rome-os/app-web-sdk`, or `@rome-os/ui` must use the published scope (no internal `@rome/*` names) and a concrete semver range — a scaffolded app installs from npm, where `workspace:*` does not resolve.
- Never vendor a component `@rome-os/ui` publishes. The template imports the
  shared page, form, list, control, and state primitives directly from their
  package subpaths, so every scaffolded app takes kit fixes with
  `pnpm up @rome-os/ui`; a copy under `src/web/components/ui/` would freeze at
  scaffold time and strand external apps.
- Don't add files the agent will likely delete on every new app. The agent prunes; we should not over-scaffold.
- Keep runtime identity in `app.yaml`; richer store-page copy and media belong in `.rome_store/rome_store.yaml`. The publish flow uploads `.rome_store` as a Rome Cloud-only sidecar and excludes it from installable app bundles.
- New apps publish their `src/` directory with the Store bundle by default. Set `includeSource: false` in `app.yaml` to keep source out of future versions.
