# Target Docs

A **target doc** states what Rome should be: the lines that stay true while the code changes, and that the code cannot tell a reader. Unlike the other families under `docs/`, which state what is true now, a target line may be ahead of the code, and then the code is what changes. This file defines where the target docs live, their format, and the bar a line clears to enter one. Prose rules come from [WRITING.md](WRITING.md).

The miss this family guards against is a target spread over many docs. What Connections should do was stated in five files, and the files drifted apart. An agent that writes, reviews or audits code then has no single line to judge the code against, and it reads the code as the target.

`pnpm lint:docs` decides the `[mech]` rules. The [check-docs](../../.claude/skills/check-docs/SKILL.md) skill runs it and judges the `[llm]` rules.

## Format

The target docs are a skeleton that exists for the whole of Rome, plus the lines a person decided beyond it.

Three files in `docs/target/` cover the whole product. `purpose.md` says what Rome is for and what it is not for. `never.md` lists what must never happen, because the first mistake already costs too much. `together.md` holds one line for each place where one concept causes something in another. Each file exists and holds text. `[mech]`

`docs/target/parts.md` lists each part as a top-level item that links to the part's `AGENTS.md`. Every folder directly under `packages/` and under `packages/core/src/` is a part, sits inside a part, or is named in code formatting under a `## Not parts` heading with the reason. `[mech]`

A part's `AGENTS.md` carries three fields, each a paragraph led by a bold label. `**Question.**` is the one question the part answers. `**Promises.**` is a numbered list of what the part offers or keeps. `**May use.**` names the other parts it may use. `[mech]`

Each concept has one file in `docs/target/concepts/` with the fields `**Purpose.**`, `**Story.**` and `**Carried by.**`. "Carried by" links to the `AGENTS.md` of a listed part. A concept that needs its own terms adds `**Words.**`. `[mech]`

A line that is not true yet carries a mark, and the mark links to the issue that makes it true. `[llm]`

> Prefer: "It offers only what `index.ts` exports. Not yet true: [#1234](https://github.com/rome-os/rome/issues/1234)."
> Over: "It offers only what `index.ts` exports. Not yet true."

## Admission

A line holds what should be true and the code cannot tell. `[llm]`

> Prefer: "The routing code cannot see which platform a message came from."
> Over: "Routing sits in `chats/routing.ts` and exports `route()`."

A line describes a state, not a step. Who does what, and in which order, stays in the issue. `[llm]`

> Prefer: "Access is checked once, when someone enters."
> Over: "Phase 1: only the team gets in. Phase 2: guests get in too."

A line changes a judgment about the code: someone who writes, reviews or audits code decides differently because of it. `[llm]`

> Prefer: "A chat keeps its messages in the order the platform sent them."
> Over: "Chats is a core part of Rome, and its code is kept clean."

A field says something a reader can hold the code to. A placeholder fails, and so does a line so wide that no code breaks it. `[llm]`

> Prefer: "**May use.** The database and the logger. Of `apps/`, only the action contract."
> Over: "**May use.** Whatever it needs."

A question tells a reader what belongs in the part and what does not. `[llm]`

> Prefer: "Who said what, where, and as whom?"
> Over: "How do chats work?"

A story is one "if ..., then ..." that a user can see happen. `[llm]`

> Prefer: "If the guardian links an agent to a connected account, then that agent answers a message sent to the account."
> Over: "Accounts are loaded at start and kept in memory."

A fact is written in one place. A rule that holds everywhere is written once, never in the doc of each part. A "decided against" sits next to the concept or part it is about. `[llm]`

> Prefer: the promise in the part's `AGENTS.md`, and a link from the concept that relies on it.
> Over: the same sentence in the concept entry and in the part's `AGENTS.md`.

Four things stay out of a target doc: a rule that holds for every repo, the state of the work, the past, and how to do a task. The state of the work lives in issues, the past in git history, and a task in a skill or a script. `[llm]`

> Prefer: "A command's answer is text or a form."
> Over: "The form answer is half built, and Feishu comes next."

A line is in a target doc because a person decided it, in a design discussion or as a correction. Where the docs say nothing, the agent decides, and its choice is not a target. `[human]`

A person says yes to every changed line. An agent may propose a change. For work of more than one PR the doc changes first, in a PR of its own, and a change that fits in one PR carries its doc lines. `[human]`

## Eviction

When a target doc and the code disagree, the doc is right. The code changes, or the line carries the mark. An agent never changes a target line to make it match the code. `[human]`

An area written in this form has no other doc that states its target. The older docs of that area leave in the same change, and git history keeps them. `[llm]`

> Prefer: the change that writes a part and its concepts also deletes that part's file under `docs/domains/`.
> Over: a concept entry in `docs/target/concepts/` beside a `docs/domains/` file that defines the same term.

The PR that makes a marked line true removes the mark. An agent may do that, because the target stays the same. `[human]`

## Intake

A decision from a design discussion, or a correction a person gives, becomes a line in the doc of the concept or part it is about, with the person's yes. `[human]`

When the check reports the same wrong finding twice, the rule it cites changes here, or its example pair does. `[human]`
