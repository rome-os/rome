# Messaging: Policies, Approvals, Addresses, Sending

What a message, a chat, an account and an agent in a chat are is defined in [`domain/chats.md`](../domains/chats.md). This file holds how Rome decides what to do with an inbound message, and the contracts of an address and of a send to an account.

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

## Address

An address is a form an [account](../domains/chats.md#account) is reachable at on its platform: a phone number, a member id, a mailbox. The platform owns the form and Rome carries it whole. Deprecated alias: *channel user id*.

**Contracts:**

- An address is opaque. No surface parses, constructs, or compares parts of one, so a platform can change the form it hands out without any reader changing.
- Every address a channel can receive a message on resolves to exactly one account. One account reachable under several addresses is one account, never two.
- Exactly one of an account's addresses is the account's own, the one a stored message names it by. Which one is the channel's answer, not a rule any reader derives.
- An address names an account, never a person. Who is behind the account is [Identity](../domains/identity.md#person)'s answer.

**Not to be confused with:**

- **[Account](../domains/chats.md#account)**: the account is the party, stable across every address it answers to. An address is one form of reach.
- **Identifier**: an identifier is a searchable fact about an account, such as an email or a profile URL. An address is what a message is addressed to, and a searchable fact is not one.

## Sending

A send to an account names that account and one of [Rome's accounts](../domains/chats.md#connected-account), and fails loudly. It is one call to the channel, answered in the request: the channel took the message, or the channel refused it and the request says why. A message the channel took joins the chat's history once the store that answers for its conversation holds it. Rome records its own copy before answering, and a channel with a mirror of its own answers for the conversation with the mirror's copy, which may land after the send answered, so a client keeps reading the chat while it is open. Rome keeps no record of a send beyond that copy, so a refused send is the client's to retry or drop.

**Contracts:**

- A send names the account it is for. Rome never chooses one of a person's accounts on the guardian's behalf: reaching for a second channel when the first is down delivers somewhere nobody picked.
- A send leaves no doubt about either end. `from` names which of Rome's accounts it goes out from, by its platform and the platform's own id, as any account is named. A `from` that is not one of Rome's accounts on the platform that can send is refused, and Rome never substitutes another account for it.
- Rome never picks among its own accounts on one platform. A send that names no `from` goes out only while Rome holds exactly one account on that platform that can send. While Rome holds several, a send that names none is refused as `not-connected`.
- A channel can be sent to only if it says so. Its `send` port's `direct` answering null is the whole declaration, so a channel Rome mirrors but cannot write to needs no flag of its own.
- A send that cannot go out is refused before the channel is called, with a 409 naming why (`SendRefusal`). A send the channel refuses answers 502 with the channel's own words. A send the channel took answers 200, even when Rome then fails to record its copy, since the message went out and a retry would send it twice.
- There is no idempotency key. A client that lost the answer to a send cannot tell whether it went out, and a retry may send it twice.
