---
name: domain-refactor
description: Move code into a bounded context so it matches the domain model, one vertical at a time, and decide alone everything that does not belong to the person. Use when handed a refactor of a context, one of its verticals, or a step of one, once the language is settled in docs/domains.
---

# Refactor code to the domain model

A vertical is a part of a domain that can be settled and built on its own, from its words and API down to its code, such as a context's model selection. Carry a vertical from plan to merged code. The work is done when the vertical lives in its context, its API passes the check below, the context's boundary crossings have not grown, and the next vertical is proposed. The person's time goes to the language and the API. Everything else is yours.

The [`ddd`](../ddd/SKILL.md) skill settles the words. This skill starts from them. [`docs/domains/`](../../../docs/domains/README.md) and the [established patterns](../../../DEVELOPMENT.md#established-patterns) are the source of truth, and the code is only evidence of what happens today.

## What you decide

Decide alone unless the choice changes a domain word, a rule, a context's boundary, an API the person signed off, or what the guardian sees. Those belong to the person.

Take such a choice to the thread that owns the domain model, then to the person with what that thread cannot settle. Ask about one concept per question, give a recommendation, and keep working on everything the answer does not touch. Hold the code that depends on the answer until it arrives. Flagging a choice is not permission to build on it.

Write down every rule you hold yourself to, in the plan or in the check that enforces it, so the person can see it and reject it. Record each correction from the person in `docs/domains/` or the plan, so no thread asks again.

## Order of work

Get what others see right first: the language people use, then the API. The internals follow from them. The person wants to be involved in these two, so bring them early and settle them before building what sits behind them.

Keep each batch small. Divide the domain into verticals and finish one before starting the next. Among the open questions, take up only the few that are coupled to each other, settle them as one batch, and leave the rest for their turn.

## The plan

Before any code, write one plan for the vertical: new words and the API first, then what moves where, which callers change, and the PR boundaries. Mark each choice that belongs to the person. Check the API, then send the plan for sign-off. Sign-off covers the whole vertical, so run its steps without asking again.

## The API

The API is what other code may call: a context's public module, its ports, and the shapes they carry. Show it in the plan as one sentence on the module's responsibility, then signatures, each with one line on what it promises. Have a fresh reviewer judge it, with no access to your reasoning, against the four checks below and the points the person has already settled. Settle each finding before the person sees the plan: fix it, or decline it with a reason in the plan.

| Check | Holds when |
|---|---|
| Consistent names | Each name is a word from `docs/domains/` or follows a written naming rule of the context. One concept has one name, and one act has one verb, across every port in the context. |
| Clear semantics | A reader who sees only the signature and its line can say what the member does, when it fails, and what stays true afterwards. The answer does not depend on the caller or the adapter. |
| Small surface | Every member has a caller today that needs it. Remove or merge before you add. A member with one caller inside the context stays private. |
| Clear responsibility | One sentence says what the module is responsible for and what it leaves to its callers. Every member and every case it handles falls inside that sentence. A case that belongs to a caller stays with that caller, even when the module could absorb it. |

Prefer the change that removes a member or a word over the change that adds one. When the checks pull against each other, ask.

## Build and merge

Build the vertical as small PRs, one step each, with callers and adapters moved in the same PR. Land a word's entry in `docs/domains/` in the PR that first uses it. Run `pnpm typecheck` and `pnpm test:unit` before each push. A context's list of boundary crossings only shrinks. Shepherd each PR with [`babysit-pr`](../babysit-pr/SKILL.md).

An API change the plan does not show goes back to the plan before you build it, however small.

Merge a PR yourself when CI is green, review is clean, and the PR builds the signed-off plan without changing a word, a rule, what the guardian sees, stored data, or a published package. Leave every other PR for the person to merge, and say which of these it changes.

## Close

When the vertical lands, update the plan and propose the next vertical with your reasons, without waiting to be asked.
