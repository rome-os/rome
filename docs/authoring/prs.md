# Pull Requests

## Cutting

A PR either refactors or changes behavior, never both. A reviewer checks a refactor by asking whether anything changed, and a behavior change by asking whether the new behavior is right. One PR cannot be read both ways.

Try to keep a PR under 400 changed lines. Past that, split it before opening, as a stack if the parts depend on each other.

Each PR can merge by itself and leaves `main` working. A PR that only works once a later one lands is not finished.

## Title

Every PR title is a Conventional Commit — `<type>[(<scope>)][!]: <subject>`, with a lower-case type and scope. Allowed types: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`.

> Prefer: `feat(app-runtime): add IpcRpcTimeoutError`
> Over: `Add IpcRpcTimeoutError to the app runtime`

The subject says what a teammate would notice, in words they already use: the feature, and what is different now. A fix names the problem it ends. One change only: if the subject needs "and" or a semicolon, name the bigger change. Keep it under about 60 characters. The terms in [`docs/domains/`](../domains/README.md) count as words a teammate uses. Code-only names do not, except in a refactor whose subject is that code.

> Prefer: `refactor(web): replace Radix and Feather icons with lucide`
> Over: `refactor(web): draw every glyph from lucide`

> Prefer: `fix(system): keep paging chat history when Slack returns a short page`
> Over: `fix(system): page a chat's history on past a short page, until an empty one`

Squash-and-merge writes the title as the commit subject on `main`, and release-please reads those subjects to pick the next version. A title that does not parse falls out of the release flow with no error. CI's `lint` job turns that into a loud failure at PR time — it is the first step, so the answer arrives before any of the build runs.

Check a title before opening the PR:

```bash
scripts/check-pr-title.sh "feat(app-runtime): add IpcRpcTimeoutError"
```

When the PR touches `packages/app-runtime-sdk/`, `packages/app-web-sdk/`, or `packages/ui/`, the type also decides the published version bump. [releases.md](../releases.md) covers which types move a version and what happens after merge.

## Description

The body is a one-minute briefing for a reviewer who already has the diff, and it becomes the squash commit body. Keep it under about 40 lines. Each section is short, and a section with nothing to say is left out, not filled with a placeholder. Use these `##` headings in this order:

| Section | When | Length |
|---|---|---|
| [Why](#why) | Always | 1–3 sentences |
| [Sketch](#sketch) | Always | One small block, about 10 lines |
| [Scope](#scope) | Always | Up to 3 bullets |
| [Merge danger](#merge-danger) | Always | 1–2 lines |
| [Evidence](#evidence) | Always | Up to 3 bullets, or one per task-spec check |

Stack history, full SHAs, and file-by-file checklists go in a PR comment, since none of it needs to reach `main`. Design rationale stays in the body: a rejected design fits in one [Scope](#scope) bullet, and rationale that will keep constraining future changes earns an [ADR](adrs.md).

### Why

Open with the problem — what was missing, broken, or accreted — and the approach, not with what changed.

> Prefer: "Two paths could write the app lockfile, so a crash mid-install stranded the app half-registered."
> Over: "Adds `installLock` to `AppManager`, updates `install.ts`, adds a test."

### Sketch

Show the shape of the change as a picture: a `diff` of an API, a call tree, a component tree, or a file tree. Keep only the parts that carry the change. A `refactor:` PR uses the sketch as its contract, since its contract is the code structure.

```diff
 AgentSession
-  sendTurn(input)
-  submitInput(input, onTurn)
+  submit(input, { priority: now | next | after })
```

### Scope

What the PR covers and what it deliberately leaves out, such as a follow-up or a known gap. When more than one reasonable design existed, one bullet names the rejected one and why. A PR stacked on or blocked by another names it here.

### Merge danger

Whether the change is a one-way door (a migration, a deleted record, a published API) or a two-way door that a revert undoes, and its blast radius: who or what it touches, and why that is safe.

> "One-way only for the old email-only records, which a revert does not restore. The next sign-in rebuilds them. Blast radius: visitor sign-in. The worst case is one extra small resend per listed visitor."

### Evidence

The behaviors the PR proves, each a scenario and its observable outcome. Mark the ones that fail without the change, since that shows the test covers it. Say how they were exercised when it is not unit tests.

> Prefer: "- Two Telegram bots, remove one: the guardian still reaches Rome through the other. Fails without the fix."
> Over: "- New cases in `connections.test.ts`."

Leave out the checks CI runs on every PR — lint, format, typecheck, the unit suite, the PR title check. List a CI job only when the PR changes what it checks, such as a migration the `db-schema` job validates.

A PR that changes what the dashboard or an app shows pastes screenshots of the changed view at phone (390×844, touch on) and desktop (1280×900, touch off) sizes, plus 320×800 when the view holds a table, a toolbar, or a row of buttons. GitHub hosts pasted images outside the repository, so never commit them. For a dashboard view, `pnpm start:web:mock` is enough. For an app, use `pnpm dev:all` with the changed app rebuilt, since mock mode serves apps from committed bundles under `packages/web/mock/public/recorded-apps`. A phone screenshot shows the layout was designed rather than left to shrink: no sideways scroll, nothing cut off at the edge, and every action reachable without hover.

### Example

````markdown
## Why
A listed visitor who deleted their Rome Cloud account and signed up again
with the same email lost the shared instance. The instance remembered
sign-ins by email, so the new account looked like a repeat and the list
was never resent.

## Sketch
```diff
 shared instance: listed visitor
   email
-  signed in before: yes | no
+  account that signed in last
```

## Scope
- Covers re-registration and an email moving between accounts.
- Old email-only records are dropped, not migrated: each listed visitor
  resends once on next sign-in. Guessing their account could bring the bug back.

## Merge danger
One-way only for the old email-only records, which a revert does not restore. The next sign-in rebuilds them. Blast radius: visitor sign-in. The worst case is one extra small resend per listed visitor.

## Evidence
- Same email, new account: resends once. Fails without the fix.
- Same account from browser then phone: one resend total.
- Old email-only record: counts once, then the field is gone. Fails without the fix.
````

## Tone

A PR title and description follow the prose rules in [WRITING.md](WRITING.md) — word choice, verbs, sentences, punctuation, structure.
