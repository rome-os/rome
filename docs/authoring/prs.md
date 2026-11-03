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

The diff already carries what changed and where. Each section below exists because the diff cannot carry it.

| Section | When |
|---|---|
| [What this PR does](#what-this-pr-does) | Always |
| [Design & Invariants](#design--invariants) | Non-trivial PRs |
| [Test plan](#test-plan) | Always |
| [Not in this PR](#not-in-this-pr) | When the PR defers something |

A section with nothing to say gets its heading omitted, not filled with a placeholder.

### What this PR does

Open with the problem — what was missing, broken, or accreted — not with what changed.

> Prefer: "Two paths could write the app lockfile, so a crash mid-install stranded the app half-registered."
> Over: "Adds `installLock` to `AppManager`, updates `install.ts`, adds a test."

### Design & Invariants

State the design as business rules: the invariants that must stay true, and what counts as a regression. A reader checks each one against the product, without opening the code, so an invariant names no file, function, type, or field. Name the durable home of each new concept — [`docs/concepts/`](../concepts/index.md) for vocabulary, [`docs/architecture/`](../architecture/index.md) for invariants.

> Prefer: "A guardian stays reachable through a service while at least one of its bots can still talk to them. Removing one bot never cuts off the others."
> Over: "Teardown deletes `channel_mappings` only when `connectionsHoldingIn(tx, service, needs, exceptId)` is empty."

> Prefer: "The routing layer never learns which channel a message arrived on. The adapter absorbs every channel specific."
> Over: "Adds a `channel` field to `RouteContext` and reads it in `TelegramAdapter`."

A `refactor:` PR is the exception. Its contract is the code structure, so it names the modules and seams it moves.

When more than one reasonable design existed, name the alternatives and why this one won. The code preserves no rejected design.

### Test plan

A checklist of the behaviors the PR proves: `[x]` for what the author verified, `[ ]` for what remains. Each item is a scenario and its observable outcome. Say when a test fails without the change, since that shows the test covers it.

> Prefer: "- [x] Two Telegram bots, remove one: the guardian still reaches Rome through the other. Fails without the fix."
> Over: "- [x] New cases in `connections.test.ts`."

After the checklist, one line says how the behaviors were exercised: unit tests with fakes, tests against a real database, or a manual run in `pnpm dev:all`. The reader weighs each item by it.

Leave out the checks CI runs on every PR — lint, format, typecheck, the unit suite, the PR title check. Their result is on the PR already. List a CI job only when the PR adds or changes what that job checks, such as a migration the `db-schema` job validates.


### Not in this PR

One bullet per deferral, each naming the deferred thing and a one-clause reason or pointer.

## Tone

A PR title and description follow the prose rules in [WRITING.md](WRITING.md) — word choice, verbs, sentences, punctuation, structure.
