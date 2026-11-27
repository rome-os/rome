# Messaging: Policies, Approvals

What a message, a chat, an account and an agent in a chat are is defined in [`domain/chats.md`](../domains/chats.md). This file holds how Rome decides what to do with an inbound message.

## Policies

A policy decides whether a message from someone [let in](../domains/participation.md#entry) wakes the agent, based on where it was said.

Evaluation order (first match wins):
1. **Thread-specific** — thread name + type match
2. **Account-specific** — match on one of Rome's [accounts](../domains/chats.md#account). A policy on a later account's own id wins, and a policy on its service covers it otherwise
3. **Global** — catch-all

Policy actions:
- **Block** — the message wakes nobody
- Any other action changes nothing

**Contracts:**

- Evaluation is strictly ordered from most to least specific, and the first matching policy wins. A more specific policy always overrides a broader one.
- With no matching policy, the message wakes the agent as the chat's rules say.
- A policy never names a sender. One an earlier release stored for a sender matches nothing.

**Not to be confused with:**

- **[Entry](../domains/participation.md#entry)** — entry decides who is let in. A policy is about a thread or an account, or every message.
- **[Approvals](#approvals)** — a policy is about inbound messages. An approval gates a sensitive action before it executes.

## Approvals

The approval system gates sensitive [actions](actions.md) behind [guardian](access.md#guardian) sign-off. When a gated action is triggered, execution pauses and Rome records an approval. The guardian approves or rejects it from the web dashboard.

**Contracts:**

- An approval-gated action does not execute before the guardian's decision: execution pauses at the gate, and a rejection means the action never runs.
- Only the guardian can decide an approval.
