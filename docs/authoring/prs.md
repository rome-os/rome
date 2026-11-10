# Pull Requests

## Title

Every PR title is a Conventional Commit — `<type>[(<scope>)][!]: <subject>`, with a lower-case type and scope. Allowed types: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`.

> Prefer: `feat(app-runtime): add IpcRpcTimeoutError`
> Over: `Add IpcRpcTimeoutError to the app runtime`

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
| [Sketch](#sketch) | When a sketch beats prose | One small block |
| [Invariants](#invariants) | When a product rule is added or changed | Up to 3 bullets |
| [Scope](#scope) | Always | Up to 3 bullets |
| [Merge danger](#merge-danger) | Always | 1–2 lines |
| [Evidence](#evidence) | Always | Up to 3 bullets |

Stack history, full SHAs, and file-by-file checklists go in a PR comment, since none of it needs to reach `main`. Design rationale stays in the body: a rejected design fits in one [Scope](#scope) bullet, and rationale that will keep constraining future changes earns an [ADR](adrs.md).

### Why

Open with the problem — what was missing, broken, or accreted — and the approach, not with what changed.

> Prefer: "Two paths could write the app lockfile, so a crash mid-install stranded the app half-registered."
> Over: "Adds `installLock` to `AppManager`, updates `install.ts`, adds a test."

### Sketch

When the shape of the change is clearer as a picture, show it: a `diff` of an API, call tree, component tree, or file tree. Keep only the parts that carry the change. A `refactor:` PR usually uses a sketch in place of Invariants, since its contract is the code structure.

```diff
 AgentSession
-  sendTurn(input)
-  submitInput(input, onTurn)
+  submit(input, { priority: now | next | after })
```

### Invariants

The business rules that must stay true, which a reader checks against the product without opening the code. An invariant names no file, function, type, or field. Name the durable home of a new concept — [`docs/concepts/`](../concepts/index.md) for vocabulary, [`docs/architecture/`](../architecture/index.md) for invariants — instead of explaining it here.

> Prefer: "A guardian stays reachable through a service while at least one of its bots can still talk to them."
> Over: "Teardown deletes `channel_mappings` only when `connectionsHoldingIn(...)` is empty."

### Scope

What the PR covers and what it deliberately leaves out, such as a follow-up or a known gap. When more than one reasonable design existed, one bullet names the rejected one and why. A PR stacked on or blocked by another names it here.

### Merge danger

Whether the change is a one-way door (a migration, a deleted record, a published API) or a two-way door that a revert undoes, and its blast radius: who or what it touches, and why that is safe.

> "Two-way door. Blast radius: visitor sign-in. The worst case is one extra small resend."

### Evidence

The behaviors the PR proves, each a scenario and its observable outcome. Mark the ones that fail without the change, since that shows the test covers it. Say how they were exercised when it is not unit tests.

> Prefer: "- Two Telegram bots, remove one: the guardian still reaches Rome through the other. Fails without the fix."
> Over: "- New cases in `connections.test.ts`."

Leave out the checks CI runs on every PR — lint, format, typecheck, the unit suite, the PR title check. List a CI job only when the PR changes what it checks, such as a migration the `db-schema` job validates.

A PR that changes what the dashboard or an app shows pastes before and after screenshots at phone (390×844, touch on) and desktop (1280×900) sizes, plus 320×800 when the view holds a table, a toolbar, or a row of buttons. GitHub hosts pasted images outside the repository, so never commit them. For a dashboard view, `pnpm start:web:mock` is enough. For an app, use `pnpm dev:all` with the changed app rebuilt, since mock mode serves apps from committed bundles under `packages/web/mock/public/recorded-apps`.

### Example

```markdown
## Why
A listed visitor who deleted their Rome Cloud account and signed up again
with the same email lost the shared instance. The instance remembered
sign-ins by email, so the new account looked like a repeat and the list
was never resent.

## Invariants
- A listed email that signs in with a different account resends the list once.
- The same account signing in again sends nothing.
- Removing an email from the list forgets its account.

## Scope
- Covers re-registration and an email moving between accounts.
- Old email-only records are dropped, not migrated: each listed visitor
  resends once on next sign-in. Guessing their account could bring the bug back.

## Merge danger
Two-way door. Blast radius: visitor sign-in. The worst case is one extra small resend.

## Evidence
- Same email, new account: resends once. Fails without the fix.
- Same account from browser then phone: one resend total.
- Old email-only record: counts once, then the field is gone. Fails without the fix.
```

## Tone

A PR title and description follow the prose rules in [WRITING.md](WRITING.md) — word choice, verbs, sentences, punctuation, structure.
