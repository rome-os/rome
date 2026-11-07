---
name: domain-refactor
description: Move code into a bounded context so it matches the domain model, one vertical at a time, and decide alone everything that does not belong to the person. Use when handed a refactor of a context, one of its verticals, or a step of one.
---

# Refactor code to the domain model

A vertical is a part of a domain that can be settled and built on its own, from its words and API down to its code. The work on one is done when its code lives in its context behind an API that meets the principles below, and the next vertical is proposed.

[`docs/domains/`](../../../docs/domains/README.md) holds the words and rules, and the [`ddd`](../ddd/SKILL.md) skill settles new ones with the person. The code shows what happens today. It never decides what should happen.

## Principles

**Work from the outside in.** What others see shapes everything behind it. Settle the language, then the API, then the internals. The person takes part in the first two, and the internals are yours.

**Take one coupled thing at a time.** Finish a vertical before starting the next. Settle together only what cannot be settled apart, and leave the rest for its turn.

**Give every boundary one responsibility.** One sentence says what a module takes on and what it leaves to its callers. Everything it handles falls inside that sentence, and a caller's case stays with the caller. Judge this from the user's side: a fact enters through the party that learns it, and a user never tells a module what the module should know itself.

**Keep rules in the domain.** A rule that someone who knows the domain would state belongs in the domain layer as a function over values, however deep it sits in a service today. The application layer only drives those rules through ports and holds state over time.

**Let the name carry the meaning.** Use the words people use. One concept has one name and one act has one verb across the context. A reader of a signature can say what it does, when it fails and what stays true afterwards, whoever calls it.

**Keep it small.** Everything public has a caller that needs it today. When something is wrong, remove or separate before you add. A rule with many cases means the model is wrong, so simplify the model.

**Own what is yours and ask about the rest.** The person owns what others see: the words, the rules, the boundaries, the API and what the guardian sees. Decide everything else alone. Take what the person owns to the domain design thread the project instructions name, through the coordinator, then to the person, one concept per question with a recommendation. With no such thread, go to the person. Build nothing on an open question, and keep working on what it does not touch.

**Leave decisions where the next agent finds them.** Every rule you hold yourself to and every correction from the person goes in `docs/domains/` or the plan, so nobody asks twice.

## The work

Plan each vertical before any code: its words, its API as a sentence of responsibility and signatures, then what moves, which callers change and the PR boundaries. A fresh subagent, given only the plan, these principles and the points already settled, reviews the API as its user would. The person then signs off once for the whole vertical. An API change the plan does not show goes back to the plan.

Build in small PRs, with callers and adapters moved together and a word's entry landing with its first use. Run `pnpm typecheck` and `pnpm test:unit` before each push. A context's list of boundary crossings only shrinks. Shepherd each PR with [`babysit-pr`](../babysit-pr/SKILL.md).

Merge a PR yourself when CI is green, review is clean, and it only builds the signed-off plan, with no change to a word, a rule, what the guardian sees, stored data or a published package. Leave any other PR for the person, and say why.
