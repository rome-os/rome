# Chats follow a default provider the guardian picks, and nothing moves them on its own

- **Status**: Accepted
- **Date**: 2026-11-16
- **Concept**: [agents — default provider](../domains/agents.md#default-provider)
- **Supersedes**: [Concierge provider failover](concierge-provider-failover.md), and amends [pinned session model](pinned-session-model-fails-closed.md)

## Context

Rome picked a model provider in a fixed order and pinned each chat to the provider of its last turn. Signing in to a second provider changed nothing, and there was nowhere to say which one to use. Removing a provider broke every chat pinned to it. Rome credits could stand in for an expired ChatGPT login while a Claude subscription sat idle. Only the Concierge moved to another provider on its own, so the same failure looked different in every kind of chat.

The cause was that "the guardian removed this provider" and "this login is broken for now" were handled the same way, and a pin outlived both.

## Decision

The guardian picks a default provider among the signed-in ones, Rome credits included. Every chat follows it, unless a developer picked an exact model. A chat moves to another provider only on the guardian's decision: changing the default after a confirm dialog, or removing the provider. The pin keeps a model within one provider and never holds a chat on another. When a provider cannot run, the chat shows a card, and unattended chats gather into one notice per outage. A move to another provider carries the chat's text into the new thread.

## Alternatives

- **Keep the Concierge's automatic failover.** Rejected because a silent move spent the other subscription, changed the voice mid-conversation, and taught the guardian that providers move on their own, while every other chat failed.
- **Fail over every chat automatically.** Rejected because a task chat's stored messages omit its tool calls, and a guardian who removed a provider expects their choice to hold.
- **Keep the fixed order and re-resolve per turn.** Rejected because the order is Rome's guess, not the guardian's, and it gave no way to prefer one subscription.
- **Ask on every failure which provider to use.** Rejected for unattended chats, which have nobody to ask. They wait for the limit to end, or for one tap on the grouped notice.
- **Use Rome credits whenever ChatGPT is out.** Rejected because it spent the guardian's credits without a decision. They run only as the default, or when nothing else is signed in.

## Consequences

A provider that cannot run stops the Concierge until the guardian acts on the card. Unattended work waits for the window reset, or for "run them on {other} now", which moves one turn and leaves the default alone.

Changing the default moves every chat that follows it. The new thread reads the chat's text and open tasks, or a handoff note when that is too long. Tool traces are not carried, so a task in the middle of its work may read files again, and the voice changes with the model.

Guardians who relied on Rome credits covering an expired ChatGPT login now see a card instead.

Future diffs must respect:

- No path moves a chat to another provider without a guardian decision. A temporary error gets one retry on the same model. A single-model limit may try another model of the same provider.
- An exact selection is never moved by a change of the default.
- A failure payload only gains fields, since older app builds read it.
