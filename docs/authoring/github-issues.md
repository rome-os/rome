# GitHub Issues

A **GitHub issue** is one tracked unit of work on the repo's issue tracker. This file defines the format of an issue. Prose rules come from [WRITING.md](WRITING.md).

## Issue types

Every issue is one of two types.

- **bug report** — a defect in behavior the system already ships. An incident write-up files as a bug report.
- **task spec** — a scoped change for a person or agent to implement: a feature, a migration step, or a follow-up spun out of a PR, incident, or audit.

## Format

### Title

A title reads `<area>: <statement>`. The area is a lower-case component or surface name, such as `relay`, `connector`, `docs`, `web`. An issue in a planned set reads the same way — a step code such as `[D1]` never leads a title, because the ordering lives in the blocked-by edges.

A bug title states the symptom in present tense, not the fix.

> Prefer: "relay: drainer reconnects every ~50s instead of persisting".
> Over: "relay: fix the drainer reconnect storm".

A task title states the action in imperative mood.

> Prefer: "docs: write the ADR family authoring guideline".
> Over: "docs: ADR authoring guideline missing".

### Situation

Every issue body opens with a **Situation** section: what is going on, in plain words, before any section that names code.

Situation uses the nouns and verbs the project already agreed on. Those live in [`concepts/`](../concepts/index.md), and a term links to its entry on first use.

> Prefer: "Rome answers one question in two places: which addresses belong to the same person?"
> Over: "The people directory and the timeline each run their own account fold."

When the situation needs a term concepts does not carry, pick one and define it in a **Terminology** section directly after Situation. One line per term, and that term everywhere below. A term used on more than one surface and carrying a contract [earns a concepts entry](concepts.md#admission) instead.

Situation names no file, symbol, or line number.

> Prefer: "the message history page gathers a person's addresses on its own, and gathers them less thoroughly than the contacts list does."
> Over: "`timeline-sources.ts:88-140` duplicates `foldAccounts` and drops the `book.resolve` branch."

### Bug report body

Required sections, in order: Situation, Symptom, How to reproduce, Initial triage, Suspected root cause, Possible fixes. An Environment section may follow.

- **Symptom** — the exact error or behavior, the trigger, and the involved surface. Situation frames the problem in plain words. Symptom carries the exact string.
- **How to reproduce** — numbered steps from a clean state, with the exact commands and environment preconditions.
- **Initial triage** — what the investigation ruled in and ruled out, with evidence.
- **Suspected root cause** — one paragraph on the mechanism, tied to the evidence above.
- **Possible fixes** — a list of options.

Possible fixes enumerates the design space and picks nothing. The author of the fix decides.

> Prefer: "1. Align `resolveWebhookUrl` with the GitHub path. 2. Fail closed at boot when the relay URL is missing."
> Over: "Fix: align `resolveWebhookUrl` with the GitHub path."

Suspected root cause states its confidence. A guess labeled as confirmed poisons the next investigation.

> Prefer: "Suspected: the backoff resets on WS open — unverified beyond the log pattern."
> Over: the same hypothesis presented as a confirmed root cause.

### Task spec body

Required sections: Situation, Scope, Acceptance. When the task depends on other issues, a **Blocked by** line names them by number.

- **Scope** — the change, and what stays out.
- **Acceptance** — a checklist of observable outcomes, each naming what proves it: a committed test, or a run against the finished branch.

Acceptance items are observable from outside the implementation.

> Prefer: "- [ ] the test fails when an ad-hoc size enters a migrated file".
> Over: "- [ ] typography is cleaned up".

Every item names what proves it. A committed test lands in the tree and runs in CI on every later change. A check runs once against the finished branch, and the PR test plan carries its evidence. An implementer builds an item that names neither as a committed test.

An item earns a committed test when what it names can break later and nothing else catches the break. An item runs once against the finished branch when the type checker, a deleted route, or an existing test already decides it.

> Prefer: "- [ ] run once: a grep for `/api/persons` returns nothing outside git history."
> Over: "- [ ] committed test: the source contains no reference to `/api/persons`."

Unless the item states how the deleted thing comes back silently, an absence item runs once. A re-imported export fails the type check and a re-registered route fails the route test, so neither earns a committed test of its own.

Scope names what stays out. A task without a boundary grows during implementation.

> Prefer: "Scope it to the files migrated in C1–C6."
> Over: a scope section that only lists inclusions.

### Labels

A bug report carries the `bug` label and exactly one of `P0`, `P1`, `P2`, `P3`. The label descriptions in the repo define the priorities. This file does not restate them.

A task spec ready for pickup carries `ready-for-agent`. The label enters when an agent can implement from the body alone, without the conversation that produced the spec.

> Prefer: a body carrying Scope, Acceptance, and its Blocked by line.
> Over: a body that says "as discussed" or links a chat transcript as the spec.