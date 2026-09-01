# CLAUDE.md Files

A **CLAUDE.md** is a file of repo guidance that its own location loads into agent context. The root file loads on every turn of every session. A nested file loads when the agent works in that directory. This file defines the format of a CLAUDE.md and the bar an entry clears to enter one. It governs `CLAUDE.md` files only, not skills. Prose rules come from [WRITING.md](WRITING.md).

The miss this family guards against is bloat. An entry that restates a source of truth elsewhere spends context on every load and goes stale when that source moves. It takes two shapes here: one rule copied into several files, so a change lands in one and not the others, and a reference doc parked inside a package's CLAUDE.md, where it loads on every turn that touches the package.

## Format

A CLAUDE.md sits at the repo root, or at the root of a directory whose contents share the same guidance. It opens with an H1 naming what it governs: the repo, the package, or the directory path. A topic title fails. `[mech]`

> Prefer: `# rome-web`, `# docs/ui/`.
> Over: `# Design System`, `# Documentation Rules`.

Every entry pairs a condition with the action to take under it. The condition comes first, per [WRITING.md](WRITING.md#structure). `[llm]`

> Prefer: "Before opening a PR, read [`docs/authoring/prs.md`](prs.md)."
> Over: "[`docs/authoring/prs.md`](prs.md) — the rulebook for the title and every description section."

The body holds at most two sections, in this order: `## Playbook`, `## Traps`. A file may omit either. A file with nothing to say is an empty file, and an empty file is deleted. `[mech]`

Before the first section, the file may carry an orientation lead: what this directory is, and where its parts sit. The lead is the one place an entry states a fact rather than pairing a condition with an action, and it enters only when the environment cannot answer it. `[llm]`

> Prefer: a lead naming each package and its role, where the `package.json` files carry no `description`.
> Over: a lead restating a directory listing.

The root file runs to 80 lines or fewer. Every other file runs to 50 lines or fewer. `[mech]`

Only `## Traps` may contain a fenced code block. `[mech]`

An entry that points at another file links it. No entry uses the `@path` import syntax, which loads the target on every load of this file. `[mech]`

### Playbook

A **playbook** entry sends the agent to the doc or the command that handles the condition. Unlike a runbook, which walks one procedure start to finish, a playbook entry states the trigger and the next move, and stops.

Each entry is one bullet. `[mech]`

### Traps

A **trap** is a default that survives every gate. Unlike a known issue, which some check reports, a trap leaves typecheck, lint, and the test suite green.

Each entry is a paragraph led by a bold sentence naming the wrong default, followed by the correct call. No entry uses a heading. `[mech]`

## Admission

Every entry names the failure it prevents. If the author cannot state what the agent does wrong without the entry, the entry stays out. `[llm]`

> Prefer: "Apps render inside a Shadow DOM. A portal that escapes it silently loses the app's styles."
> Over: "Apps render inside a Shadow DOM."

Four answers reject an entry.

An entry fails on **default** when the agent already does it without being told. `[llm]`

> Prefer: "All imports use `.js` extensions, even for TypeScript files."
> Over: "Read the existing code before changing it."

An entry fails on **lookup** when one file or one command holds the answer and the agent looks there on its own. Point at that source instead of copying it. `[llm]`

> Prefer: "Root `package.json` scripts delegate to the right workspace. Read it for the full list."
> Over: a fenced block listing `dev`, `build`, `typecheck`, and `lint`.

An entry fails on **aspiration** when no failure follows from ignoring it. `[llm]`

> Prefer: "Sequence a migration so the break lands last, or behind a switch."
> Over: "Keep the codebase healthy."

An entry fails on **scope** when it bears on only some of the work in its directory. A procedure that runs on some tasks becomes a skill, and reference material becomes a doc under `docs/`. The file keeps a `Playbook` entry naming the trigger. `[llm]`

> Prefer: "Before building or editing an app, read [`app_creation/SKILL.md`](../../rome_apps/coding/src/skills/app_creation/SKILL.md)."
> Over: the create and scaffold steps written out in `rome_apps/CLAUDE.md`.

Each section adds its own bar.

A `Playbook` entry enters when the agent, meeting the condition, would otherwise take a different action. `[llm]`

> Prefer: "When doing frontend-only work in `packages/web`, use `pnpm start:web:mock`."
> Over: "`pnpm start:web:mock` runs the dashboard against mock data."

A `Traps` entry enters when typecheck, lint, and the test suite all pass and the code is still wrong. If a gate catches it, fix the gate. `[llm]`

> Prefer: "Floating UI portals into `document.body`, outside the app's shadow root, where it silently drops the app's styles. Pass `getPortalContainer()` to every `Portal`."
> Over: "Sort imports before committing."

An entry names the failure and the corrective action. It carries no values, utility classes, or token names that a doc already owns — those sit behind the pointer, where one edit updates them. `[llm]`

> Prefer: "Focus renders invisible when only part of the outline recipe is written. `docs/design-system.md` carries the full set."
> Over: the same entry with the five focus utilities spelled out in a fenced block.

An entry enters a nested file when it holds in that directory and no file above already states it. `[llm]`

> Prefer: a nested SDK file holding only the `rome` CLI naming rule.
> Over: two nested SDK files repeating the release rule the root file already states.

## Eviction

An entry whose named failure cannot happen leaves. `[human]`

When a directory's behavior changes, re-run the admission bar on that directory's file. An entry that now fails leaves. `[human]`

When a file exceeds its line budget, the overflow leaves and the file keeps one `Playbook` entry pointing at it. Content that fails admission but stays true moves rather than disappears, and it moves by kind: a procedure the agent runs on some tasks becomes a skill, and reference material becomes a doc under `docs/`. `[human]`

When the agent ignores an entry across sessions, the file is too long. Cut entries. Emphasis does not recover a rule the file lost in noise. `[human]`

## Intake

A correction that recurs across sessions becomes an entry, or the maintainer rejects it in writing and states the reason. A correction that recurs with neither outcome means the file is dead. `[human]`

When the agent asks a question an entry already answers, the entry is ambiguous. Rewrite it, or cut it. `[human]`

An entry lands in the file closest to the code it governs. `[llm]`

> Prefer: a rule about `packages/ui` landing in `packages/ui/CLAUDE.md`.
> Over: the same rule landing in the root file.
