# A Concierge for each person on the dashboard, private to them

- **Status**: Accepted
- **Date**: 2026-11-06

## Context

Every chat on the dashboard is open to every dashboard user, and a visitor on the dashboard allow-list reads and edits the guardian's memory and settings. The Concierge was the guardian's alone: one main chat, one list of follows, one digest, one set of quiet hours.

A visitor who uses the dashboard wants a Concierge of their own, one that follows their things and tells them, not the guardian. The guardian wants their alerts, tasks and conversations with the Concierge kept from visitors, and a visitor wants the same. Memory and connections are the instance's, so splitting them would mean a second memory and a second set of grants per person.

## Decision

When the Concierge is on, the guardian and every visitor on the dashboard allow-list each have their own Concierge: their own main and topic chats, follows, task list, digest times, quiet hours and time zone. Each person's Concierge chats and the task chats it starts are private to them, the guardian included. Memory and connections stay shared. Approvals stay with the guardian.

## Alternatives

- **One Concierge shared by every dashboard user.** Rejected because one person's alerts and tasks would reach everyone, and a digest or quiet hours could fit only one of them.
- **A switch per visitor.** Rejected because the allow-list already says who uses the dashboard, and a second list could disagree with it.
- **A Concierge for app users too.** Rejected because an app user reaches only the apps the guardian shares, not the dashboard where a Concierge lives.
- **A memory per person.** Rejected because memory is the instance's one memory, which every agent reads, and a split would need a second memory store and a rule for which one each agent reads.
- **Visitor chats open to the guardian.** Rejected because a visitor would then have no private place to ask the Concierge anything, while the guardian still sees every approval a visitor's Concierge raises.
- **One triage run per event for everyone who follows it.** Rejected because each person's preference, options and what they were told recently decide what is important to them, so the same event can matter to one and not the other.

## Consequences

Two people who follow the same thing each hear it, once each. The connection still arms one subscription for the thing, and it is released only when nobody follows it.

Future diffs must respect:

- A Concierge chat, a task chat it starts, and a child session of either (a fork, a subagent) answer as not found to anyone but their owner, on every path that reads or writes a chat. A child session takes its parent's privacy when it is made.
- A follow, a task row and a kept event record the owner of the chat they were made in, and keep it after that chat is gone. A stored event is unique per owner and event.
- Triage, the hourly cap of important turns, quiet hours and the digest are each owner's own.
- Memory and connections are shared, and approvals are decided by the guardian.

The invariants live in [Concierge](../architecture/concierge.md).
