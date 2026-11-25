# Messaging: Policies, Sentinel, Approvals

What a message, a chat, an account and an agent in a chat are is defined in [`domain/chats.md`](../domains/chats.md). This file holds how Rome decides what to do with an inbound message.

## Policies

A policy decides whether a message from someone [let in](../domains/participation.md#entry) wakes the agent, based on who sent it and where.

Evaluation order (first match wins):
1. **Sender-specific** — exact [person](people.md#person) match
2. **Thread-specific** — thread name + type match
3. **Account-specific** — match on one of Rome's [accounts](../domains/chats.md#account). A policy on a later account's own id wins, and a policy on its service covers it otherwise
4. **Global** — catch-all

Policy actions:
- **Block** — the message wakes nobody
- Any other action changes nothing

**Contracts:**

- Evaluation is strictly ordered from most to least specific, and the first matching policy wins. A more specific policy always overrides a broader one.
- With no matching policy, the message wakes the agent as the chat's rules say.

**Not to be confused with:**

- **[Bond level](people.md#bond-levels)** — a bond level is an attribute of a person. A policy is about one person, thread or account, or every message, and never reads it.
- **[Approvals](#approvals)** — a policy is about inbound messages. An approval gates a sensitive action before it executes.

## Sentinel

The sentinel is a lightweight [agent](agents.md) that triages messages from untrusted senders. No message reaches it. Given one, the sentinel decides:

- **Reply** — respond directly (logged)
- **Escalate** — forward to the [main agent](agents.md#agent-hierarchy)
- **Ignore** — drop the message (logged)

**Contracts:**

- All sentinel decisions are recorded in the sentinel log. The dashboard does not show it. Each entry names the channel the message arrived on and the sender's [account](../domains/chats.md#account), by its platform and the sender's id there.

**Not to be confused with:**

- **Envoy** — the envoy validates *outgoing* messages. The sentinel triages *incoming* messages (see [agent hierarchy](agents.md#agent-hierarchy)).

## Approvals

The approval system gates sensitive [actions](actions.md) behind [guardian](people.md#guardian) sign-off. When a gated action is triggered, execution pauses and Rome records an approval. The guardian approves or rejects it from the web dashboard.

**Contracts:**

- An approval-gated action does not execute before the guardian's decision: execution pauses at the gate, and a rejection means the action never runs.
- Only the guardian can decide an approval.

**Not to be confused with:**

- **[Sentinel](#sentinel)** — the sentinel triages inbound *messages*. An approval gates a sensitive *action*.
