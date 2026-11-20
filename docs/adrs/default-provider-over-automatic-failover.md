# Chats follow a default provider the guardian picks, and nothing moves them on its own

- **Status**: Accepted
- **Date**: 2026-11-16, amended 2026-11-19
- **Concept**: [agents — default provider](../domains/agents.md#default-provider)
- **Supersedes**: [Concierge provider failover](concierge-provider-failover.md), and amends [pinned session model](pinned-session-model-fails-closed.md)

## Context

Rome picked a model provider in a fixed order and pinned each chat to the provider of its last turn. Signing in to a second provider changed nothing, and there was nowhere to say which one to use. Removing a provider broke every chat pinned to it. Rome credits could stand in for an expired ChatGPT login while a Claude subscription sat idle. Only the Concierge moved to another provider on its own, so the same failure looked different in every kind of chat.

The cause was that "the guardian removed this provider" and "this login is broken for now" were handled the same way, and a pin outlived both.

## Decision

The guardian picks a default provider among the logged-in accounts. Rome credits can be it only while no AI account is logged in, and the first login replaces them. Every chat follows the default, unless its owner picked a model. A chat moves to another provider only on the guardian's decision: changing the default (optionally leaving existing chats where they are), logging out of the default, or switching one chat from a card. The pin keeps a model within one provider and never holds a chat on another.

Rome recovers by itself only when no context is lost, no money is spent and nobody's pick is overridden: one silent retry for a temporary error, and another model of the same provider for one model's limit. Anything else shows one of three cards by what the guardian has to do (wait, fix the account, change the model). The card settles in place and the stopped turn resumes. Unattended chats get their card and one grouped notice per incident. A move to another provider carries a handoff from the old model when it can still run, else the chat's text and the tools the latest turns called.

## Alternatives

- **Keep the Concierge's automatic failover.** Rejected because a silent move spent the other subscription, changed the voice mid-conversation, and taught the guardian that providers move on their own, while every other chat failed.
- **Fail over every chat automatically.** Rejected because a task chat's stored messages omit its tool calls, and a guardian who removed a provider expects their choice to hold.
- **Keep the fixed order and re-resolve per turn.** Rejected because the order is Rome's guess, not the guardian's, and it gave no way to prefer one subscription.
- **Ask on every failure which provider to use.** Rejected for unattended chats, which have nobody to ask. They wait for the limit to end, or for one tap on the grouped notice.
- **Use Rome credits whenever ChatGPT is out, or as a default beside a login.** Rejected because it spent the guardian's credits without a decision, and two ways to run Codex at once confused which one paid. They run only while no AI account is logged in.
- **Move every existing chat in one batch when the default changes.** Rejected because it interrupts running turns and writes a handoff for chats nobody opens again. Each chat moves at its next run.

## Consequences

A provider that cannot run stops the Concierge until the guardian acts on the card or the provider recovers. Unattended work waits for the window reset, or for one tap on the grouped notice, which moves those tasks and leaves the default alone unless "Also make default" is ticked.

Changing the default moves every chat that follows it, unless the guardian unticks "Move existing chats too". A move while the old provider still runs waits a few seconds for the old model's handoff. Tool results are not carried, so a task in the middle of its work may read files again, and the voice changes with the model.

Guardians who relied on Rome credits covering an expired ChatGPT login now see a card instead.

Future diffs must respect:

- No path moves a chat to another provider without a guardian decision. A temporary error gets one retry on the same model. A single-model limit may try another model of the same provider.
- An exact selection is never moved by a change of the default.
- A failure payload only gains fields, since older app builds read it.
