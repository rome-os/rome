# Domains Entries

**Domain entries** — the shared language for chats, accounts, agents and connections — live in [`domains/`](../domains/README.md), one file per bounded context. The family follows Domain-Driven Design: a context answers one question, and every word inside it has one meaning. Unlike a [concepts](concepts.md) entry, which records one term and its contracts wherever it is used, a domain entry belongs to a context and means nothing outside it. The miss that earned this family: the same thing was called channel, connection, bot account and linked agent on different surfaces, and every design discussion started by defining the words again.

## Format

One file per context, named for the context in kebab-case, plus `README.md` holding the context table, the context map and where the code stands. `[mech]`

A context file opens with an H1 naming the context and one line stating its question. `[mech]`

One H2 per word, in the word's canonical form. Under it: the meaning in one or two sentences, then a bullet list of the rules that go with the word: identity (when two are the same), lifetime (when it starts and ends), operations (the verbs, in bold on first use) and what must stay true. A word with no rules has the meaning alone. `[mech]`

Every context file ends with `## Decided against`: one bullet per rejected alternative, naming the force that killed it, not the verdict alone. `[llm]`

> Prefer: "A thread as a chat of its own. People do not think of a thread as a chat."
> Over: "A thread as a chat of its own. Rejected."

Entries name no file, type or function. A rule states behaviour the guardian can observe. `[llm]`

> Prefer: "A connected account may have no agent, and Rome then does not listen to it."
> Over: "`AccountListening.listens()` returns false when no agent is linked."

## Admission

A word earns an entry when all hold: `[llm]`

1. The guardian uses it, or needs one word for a thing they describe in several.
2. It belongs to one context. A word two contexts need is two entries, one per context, each with the meaning that context gives it ([Agent](../domains/chats.md#agent) in Chats and [Agent](../domains/agents.md#agent) in Agents).
3. It is separable from every word in its context in one line. If that line cannot be written, it is the same word.

> Prefer: adding "thread" after the guardian described a side conversation started from a message.
> Over: adding "topic" because an adapter names a thread that way.

## Eviction

A word leaves when the guardian stops using it and no rule hangs on it. A deprecated alias stays listed under its canonical word until the last surface using it is renamed, then leaves. `[human]`

## Intake

A recurring correction about what one of these words means becomes a rule under that word, or the maintainer rejects it in writing with the reason. A decision argued twice becomes a bullet under `## Decided against`. `[human]`

A change to a rule lands in the same PR as the code that follows it, and a new word enters here before it enters code, UI copy or a doc. `[llm]`

> Prefer: a PR that renames the dashboard label and updates the word's entry together.
> Over: a PR that renames the label and leaves the entry for later.
