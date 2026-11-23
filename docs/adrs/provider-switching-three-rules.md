# Provider switching follows three rules: one default, three ways it changes, and failures change nothing

- **Status**: Accepted
- **Date**: 2026-11-22
- **Concept**: [agents — default provider](../domains/agents.md#default-provider), [pinned chat](../domains/agents.md#pinned-chat)
- **Amends**: [Chats follow a default provider the guardian picks](default-provider-over-automatic-failover.md)

## Context

The default provider let the guardian choose where chats run, but an independent review found its switching hard to predict. A chat kept on another provider showed nothing, so the guardian could not see why it answered in another voice. "Move existing chats too", unchecked, held only the top-level web chats: forks, a channel's chats and subagents moved anyway. Logging out of the last account left no default, and the chats paused with no word of Rome credits. A card's options were frozen when it was written, so a click on one that stopped working only failed. One model overload lowered a chat's model for good.

The guardian settled the rules in a Q&A, and they are three:

1. One default. Each chat follows it or is pinned to a model, a pinned chat always says so, and one tap brings it back.
2. The default changes in three cases only: the guardian sets it, a login when no usable account existed, and a logout of the default. Each change that moves chats asks "Move existing chats too", checked.
3. A failure changes nothing by itself. It writes a card, and the guardian clicks Retry or Switch. An overload swap lasts one turn.

## Decision

Rome follows the three rules everywhere a provider changes. An unchecked move keeps every existing conversation on its provider, whatever kind it is. The last logout hands the default to Rome credits. A logout to an expired account still hands it the default and warns. Nothing resumes a stopped turn by itself: every card has Retry. A stale option writes a fresh card. An overload swap runs one turn on the other model and never stores it.

## Alternatives

- **Drop "Move existing chats too" and always move every chat.** Rejected because the guardian keeps some chats on a provider on purpose, such as a long task in the middle of its work, and moving it costs its tool context and changes its voice. The checkbox stays, checked, and now holds every kind of chat, so it means what it says.
- **Resume stopped turns by themselves after a login, a top-up or a default change.** Rejected because a resume beside the usage-limit continuation raced it, and each needed its own checks for a stale request, a newer message and a restart. A turn that runs long after it was asked may act on what the guardian has since given up. Retry on every card runs it at once, on a click the guardian chose.
- **Skip an expired account on logout, and leave no default.** Rejected because an expired login is still the guardian's account: it is fixed by logging in again, and the default never moves on expiry anyway. Skipping it would make the same account count as logged in for one rule and out for another. The dialog warns instead.
- **Keep the old default after the last logout, so the next send shows why.** Rejected because the chats then showed a card naming a provider that was gone, and Rome credits, the one way on, were hidden behind it. Credits are what runs with no account, so they become the default, and the dialog says so.
- **Ask before a login replaces Rome credits.** Rejected because credits run only while no account is logged in: once one is, no chat can stay on them, so there is no choice to ask about.
- **Keep the weaker model after an overload, as before.** Rejected because an overload passes in minutes, and the chat then ran a weaker model for good without a decision. A per-turn swap recovers the turn and tries the chat's own model again next time.
- **Refresh a card's options live.** Rejected because the card rewrote itself while the guardian read it, and every client had to follow. A click on an option that does not work now writes a fresh card instead.
- **Show nothing for a chat kept from a card.** Rejected because a kept chat was invisible and permanent: the guardian could not tell why it answered on another provider, nor undo it. Every pinned chat says so and offers "Back to default".

## Consequences

The guardian can predict where a chat runs from what they did: their pick, their checkbox, their login or logout. A failure never surprises them with a move.

Every conversation an unchecked move keeps is held by its session, so a fork, a channel's chat and a subagent stay with the conversation they belong to. A held conversation runs on the guardian's own account and never on Rome credits. Holding them all means a checked move later has more to release.

A stopped turn waits for a click, a new message, or the usage-limit continuation, so unattended work after a login waits until the guardian opens its card.

An overload that lasts makes every turn try the chat's own model first, and fail over once per turn.

Future diffs must respect:

- No path moves the default or a chat's model because a provider failed.
- A change of the default that leaves chats where they are leaves every kind of conversation there.
- A chat that does not follow the default reports so in the chat APIs, and those fields only gain members, since older app builds read them.
- An overload swap is never stored as the chat's model.
