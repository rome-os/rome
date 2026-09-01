# Task Specs

A **task spec** is a GitHub issue for a scoped change a person or agent implements: a feature, a migration step, or a follow-up spun out of a PR, incident, or audit. [github-issues.md](github-issues.md) holds the rules every issue shares — the title shape, the Situation section, the type labels — and wins where a rule here conflicts with it.

## Title

A task title states the action in imperative mood.

> Prefer: "docs: write the ADR family authoring guideline".
> Over: "docs: ADR authoring guideline missing".

## Body

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

## Labels

A task spec carries the `task` label. A task spec ready for pickup also carries `ready-for-agent`. The label enters when an agent can implement from the body alone, without the conversation that produced the spec.

> Prefer: a body carrying Scope, Acceptance, and its Blocked by line.
> Over: a body that says "as discussed" or links a chat transcript as the spec.
