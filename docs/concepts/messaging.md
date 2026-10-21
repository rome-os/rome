# Messaging: Policies, Sentinel, Approvals

What a message, a chat, an account and an agent in a chat are is defined in [`domain/chats.md`](../domains/chats.md). This file holds how Rome decides what to do with an inbound message.

## Policies

The policy engine decides how to handle each incoming message based on who sent it and where.

Evaluation order (first match wins):
1. **Sender-specific** — exact [person](people.md#person) match
2. **Thread-specific** — thread name + type match
3. **Sender tier** — [bond level](people.md#bond-levels) match
4. **Account-specific** — match on one of Rome's [accounts](../domains/chats.md#account). A policy on a later account's own id wins, and a policy on its service covers it otherwise
5. **Global** — catch-all

Policy actions:
- **Allow** — route to the [main agent](agents.md#agent-hierarchy)
- **Block** — drop the message
- **Sentinel review** — triage through the [sentinel](#sentinel)

**Contracts:**

- Evaluation is strictly ordered from most to least specific, and the first matching policy wins. A more specific policy always overrides a broader one.
- Default behavior: guardian messages are allowed, and everyone else goes through sentinel review. Which bond levels are trusted is configurable.

**Not to be confused with:**

- **[Bond level](people.md#bond-levels)** — a bond level is an attribute of a person. A policy is a routing rule that may key on it.
- **[Approvals](#approvals)** — a policy routes inbound messages. An approval gates a sensitive action before it executes.

## Sentinel

The sentinel is a lightweight [agent](agents.md) that triages messages from untrusted senders. When the [policy engine](#policies) routes a message to sentinel review, the sentinel decides:

- **Reply** — respond directly (logged for [guardian](people.md#guardian) review)
- **Escalate** — forward to the [main agent](agents.md#agent-hierarchy)
- **Ignore** — drop the message (logged)

**Contracts:**

- All sentinel decisions are recorded in the sentinel log, which the guardian reviews from the Inbox triage view.
- The sentinel only sees messages the [policy engine](#policies) routes to it. It is not in the path of trusted senders' messages.

**Not to be confused with:**

- **[Policies](#policies)** — the policy engine decides *whether* the sentinel sees a message. The sentinel decides *what to do* with it.
- **Envoy** — the envoy validates *outgoing* messages. The sentinel triages *incoming* messages (see [agent hierarchy](agents.md#agent-hierarchy)).

## Approvals

The approval system gates sensitive [actions](actions.md) behind [guardian](people.md#guardian) sign-off. When a gated action is triggered, execution pauses and Rome records an approval. The guardian approves or rejects it from the web dashboard.

**Contracts:**

- An approval-gated action does not execute before the guardian's decision: execution pauses at the gate, and a rejection means the action never runs.
- Only the guardian can decide an approval.

**Not to be confused with:**

- **[Sentinel](#sentinel)** — sentinel review triages inbound *messages*. An approval gates a sensitive *action*.
