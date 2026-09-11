---
name: app_creation
description: Scaffold a brand-new Rome app from a bundled template into an independent, git-versioned source directory and install it from there. Use for genuinely **app-shaped** software — something with its own user-edited data model, several distinct operations, or a conversational/long-lived agent. FIRST apply the litmus in "Is this an app, or a workflow?" below: most "build me something that does X" requests are pipelines, not apps — if the work is inputs → a sequence → a result (a summary, digest, draft, triage, "do X when Y"), STOP and use `coding:workflow_creation` instead. Use `coding:app_remix` instead when the source is an installed App Store app. Do not improvise the create flow, do not let the daemon pick paths, do not scaffold files by hand. After install, use `system:summon` with `assistant:assistant` to run `coding:app_verification` against the installed app before claiming it works. Skip this skill for editing an existing installed app or read-only inspection.
tools: [Read, Edit, Bash]
---

# App Creation

Takes the agent from "I want to build app X" to "a permanent git-versioned working tree exists at `$REPO` and the daemon is reading from it." Once that's true, hand control to [`AUTHORING.md`](./AUTHORING.md) for the edit → commit → install loop.

## First: is this an app, or a workflow?

Most "build me something that does X" requests are **workflows**, not apps. Apply this litmus *before* scaffolding:

> A **workflow** takes inputs, runs a sequence (transform, call actions, use `system:summon` for an LLM step), and **returns a result** — summaries, digests, drafting/writing, triage, monitor-and-notify, multi-source synthesis, "do X when Y". This is the default — *including* when the user wants to run it repeatedly and review past runs (the platform persists run history for free; authors never build that).
>
> Scaffold a full app **only if at least one is true**:
> 1. **It owns a data model the *user* edits** — records they create / update / delete and return to (tracker, CRM, library, kanban). Wanting to see past *runs* does **not** count — that's free platform history, not a custom data model.
> 2. **It has more than one distinct operation** — several verbs the user chooses between (add, browse, configure, approve…), not just "run it". A single trigger, even with inputs, is still a workflow.
> 3. **It has a conversational or long-lived agent** — something the user talks to, or that carries memory/its own tools across turns. A one-shot "generate X from Y" is a `system:summon` step, **not** an agent.
>
> **None of those → STOP and use [`coding:workflow_creation`](../workflow_creation/SKILL.md) instead.** Two smells that you've mis-split a pipeline into an app: reaching for a `db:` section to store past outputs, or standing up a custom agent for a one-shot generation. A workflow is a **verb** (do this, give me the result); an app is a **noun** (a place that holds my stuff).

If — and only if — the litmus says app, continue.

## Invariants this skill enforces

1. **Every app has a permanent, version-controlled source home.** The agent picks an absolute path *up front*, scaffolds the template into it, then runs `git init` and commits — so the bundled template lands as the first commit inside a tracked tree. There is no throwaway "session" — `$REPO` is where the app lives forever, and the agent can audit its own work through `git log` / `git diff`.
2. **`spec.source` points at `$REPO` itself with `mode: "source"`** — the daemon owns build + pack + install as one `install`. It runs the workspace's `pnpm install` + `pnpm build`, packs into `$REPO/.rome/artifact` (daemon-managed; never edit or commit it), and installs the packed artifact. Every install call must pass `source` explicitly — the daemon does not infer it from the lockfile. Subsequent installs pass the same `{ mode: "source", path: "<absolute $REPO>" }`.
3. **Every generated app uses format version 2 canonical artifact ids.** Definitions keep only an app-local `name` (`review`, `run`, `researcher`); every reference or runtime call uses `<app-id>:<local-name>`, including same-app references. Never emit a bare artifact reference or `self:<name>`. Platform examples must use their real owners: `system:summon`, `system:create_routine`, `system:send_message`, `connector:connector_proxy`, `core:main`, and `assistant:assistant`. The full fixed-id table is in [`REFERENCE.md`](./REFERENCE.md#canonical-artifact-ids).

## The scaffold flow

```bash
# 1. Pick an absolute path for the app's repo UNDER the "Custom app authoring
#    directory" given in your Runtime Context (`~/.rome/<profile>/projects/apps`)
#    — i.e. <authoring-dir>/<appId>. This tree is both the canonical authoring
#    root and the runtime source of truth, and it sits under the projects root
#    so the app shows up in the dashboard. Do NOT use `$HOME/projects` — that is
#    off the projects tree and the app would be invisible. <appId> must match
#    /^[a-z][a-z0-9-]*$/ — short, lowercase, hyphenated.
REPO="${ROME_APP_AUTHORING_ROOT:-$HOME/.rome/${ROME_PROFILE:-default}/projects/apps}/<appId>"
mkdir -p "$REPO" && cd "$REPO"

```

```jsonc
// 2. Call `system:app_management` to scaffold the template into the empty dir. rootPath is required and
//    absolute — the daemon does not pick a default. It refuses a non-empty
//    directory, so this must run BEFORE `git init` (a `.git/` dir counts as
//    non-empty and would make the scaffold fail).
{ "op": "create", "appId": "<appId>", "rootPath": "<absolute $REPO>" }
```

```bash
# 3. Move the scaffolded package.json onto the current SDK release. The
#    template carries a floor, not the latest — pnpm resolves each one now and
#    writes back a concrete caret range. Run this BEFORE the baseline commit so
#    the versions land in commit #1. Drop `@rome-os/ui` if package.json does not
#    already list it: the workflow template has no web UI.
pnpm add @rome-os/app-runtime@latest @rome-os/app-web-sdk@latest @rome-os/ui@latest

# Also fill in app.yaml: `name`, `description` (written for agents), and
# `tagline` (written for people: one sentence, ≤ 80 chars / 40 CJK,
# benefit-first, like an App Store subtitle). The tagline is the share card's
# ONLY description — there is no fallback — so uncomment and fill it in, and
# update it whenever the app's purpose changes.

# 4. git init AFTER scaffolding. Initializing on top of the freshly
#    materialized template means commit #1 (next step) is "the scaffold as
#    shipped" and every subsequent diff is scoped to the agent's own work.
git init

# 5. Commit the scaffold as a clean baseline. The scaffold ships a
#    `.gitignore` that excludes `.rome/` and `dist/`, so build/pack output
#    never lands in git.
git add -A && git commit -m "Initial scaffold of <appId>"
```

```jsonc
// 6. Install. One call: the daemon runs the workspace's `pnpm install` +
//    `pnpm build`, packs into $REPO/.rome/artifact, and installs the packed
//    artifact. spec.source pins the SOURCE repo, not the artifact. No appId —
//    the daemon derives it from the manifest and returns it.
{ "op": "install", "source": { "mode": "source", "path": "<absolute $REPO>" } }
```

The app is now installed. `$REPO` is its permanent source home; `$REPO/.rome/artifact` is the daemon-managed packed artifact (never edit or commit it). From here on, iterate per `AUTHORING.md`: edit → `git commit` → `{ op: "install", source: { mode: "source", path: "<absolute $REPO>" } }` — the daemon rebuilds and repacks on every install. Always pass `source` — the daemon does not remember it. (Run `pnpm install && pnpm build` locally only when you want build errors or `rome dev` HMR before installing.)

## Mandatory independent verification

After the app is created, committed, installed, and locally smoke-tested,
delegate verification to a **fresh subagent with clean context**. Do not verify
only in the same context that authored the app; that preserves design and
implementation biases.

Run `system:summon` with the `assistant:assistant` agent and tell it to load
[`coding:app_verification`](../app_verification/SKILL.md). Pass only the verification
handoff: `appId`, absolute `$REPO`, artifact path, dashboard/API base URL if
known, the original user intent, expected happy path, and safe sample inputs.
The verifier must visit or probe the installed app at runtime and return a
verdict with evidence, issues, gaps, and suggested extra checks. Include that
verdict in the final handoff.

## After setup, before writing code

Read both companion docs before editing any source file. They are split by purpose, not by topic — most features touch both:

- **[`AUTHORING.md`](./AUTHORING.md)** (workflow): iteration loop, product-design rules, frontend design guideline, icon design, recurring-run pattern, boundaries, validation, delivery checklist. Read this once up front to understand *what* to build and *when* to ship.
- **[`REFERENCE.md`](./REFERENCE.md)** (file-level API): field-by-field meaning of `app.yaml` / `action.yaml` / agent yaml; the `@rome-os/app-runtime` and `@rome-os/app-web-sdk` surfaces; on-disk layout; the `rome` CLI; storage + UI rules. Re-read targeted sections any time you need a refresher on a specific file or API.

## Failure modes

- **`apps.create: rootPath is required`** — `rootPath` was omitted from `op: "create"`. The daemon never picks a default; supply the absolute path chosen in step 1.
- **`scaffoldDevApp: rootPath must be an absolute path`** — the path you passed was relative or contained an unexpanded `~`. Resolve to a fully-qualified path first.
- **`App directory <path> already exists and is non-empty`** — either reuse the existing repo (skip steps 2–5 and jump to step 6) or pick a fresh path. A common trigger is running `git init` *before* `op: "create"` — scaffold into the empty dir first, then `git init`. Do not delete pre-existing contents to "fix" this — they may be the user's prior attempt.
- **`op: "install"` fails because `source` is missing** — every install requires `source`. Pass `{ mode: "source", path: "<absolute $REPO>" }` on every iteration, exactly as shown in step 6.
- **`op: "install"` fails with ARTIFACT_INVALID naming a mode/shape mismatch** — the declared `source.mode` disagrees with what's on disk (e.g. `mode: "source"` pointing at `$REPO/.rome/artifact`, or `mode: "bundle"` pointing at the repo root). The error names the exact source to pass — follow it verbatim; do not delete or restructure the directory to "fix" the shape.
- **`pnpm add` in step 3 fails to reach the registry** — skip it and continue. The template floor installs, and `pnpm up` from `$REPO` takes the app to the current release once the network returns.
- **`op: "install"` fails with "App build failed in …"** — the workspace's own `pnpm install` / `pnpm build` failed inside the daemon. The previously installed version keeps running. Reproduce locally with `pnpm --dir "$REPO" install && pnpm --dir "$REPO" run build`, fix the error, re-install.

## Scope

Brand-new apps from templates only. Use `coding:app_remix` for a new app derived from an installed App Store app. Editing an existing installed app, the write-protection mechanism, and worktree-based forks use different flows.
