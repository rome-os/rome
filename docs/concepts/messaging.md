# Messaging: Messages, Chats, Rome's accounts, Policies, Sentinel, Approvals

## Message

A message is one thing somebody said — a line a person sent to Rome, or one Rome sent back, with whatever came attached to it. It reaches Rome through one of [Rome's accounts](#romes-accounts), from or to an [account](people.md#account).

**Contracts:**

- Every message names the account that sent or received it and which of Rome's accounts carried it. Who that account belongs to is the account's [link](people.md#link), so who said something changes only when a link does, retroactively and over their whole history.
- A message goes one of two ways: to Rome, or from it. Every message declares which, and there is no third direction.
- A message carries who said it, the chat it was said in, and what came attached, wherever the record it was read from kept them. It is one record whichever way Rome reads it: delivered as it arrives, or read back later.
- A message is what was said, which is not the same as what Rome holds. A platform that keeps its own record has the chat back past the point Rome started watching. Where Rome keeps the only record, the history starts when Rome did.

**Not to be confused with:**

- **[Rome's accounts](#romes-accounts)** — one of Rome's accounts is what carried a message. The message is what was said through it.
- **[Chat](#chat)** — the chat is where a message was said. The message is the one line.
- **[Account](people.md#account)** — the account is who said it. The message is what they said.
- **Notification** — a notification is an out-of-band delivery to the guardian. It lands in the same transcript, but nobody sent it through an account.

## Chat

A chat is where a [message](#message) was said: a group, a direct message, the chat built into the dashboard, named by the platform's own id for it. Every message belongs to exactly one. Deprecated alias: *conversation*, the name the code still uses.

**Contracts:**

- A direct chat is addressed by the person on it. A group chat is addressed by the group and by nobody on it, so no account names one and no read scoped by an account reaches one.
- A chat belongs to the one of [Rome's accounts](#romes-accounts) it was seen through. Two of Rome's accounts are free to spell an id the same way and mean two different chats.
- What a chat holds and what passed between Rome and a person are two questions to one store, not two histories: Rome answers both from the record it already keeps for that account.

**Not to be confused with:**

- **[Account](people.md#account)** — the account is who Rome is talking to. The chat is where they said it. On a direct chat the two are named by one string. On a group they are not.
- **Session** — a session is Rome's own working context for a chat. The chat itself exists whether or not Rome ever opened a session on it.

## Rome's accounts

One of Rome's accounts is an account on a platform that Rome holds a connection to, so Rome can send and receive as it: the Telegram or Feishu account created for an agent, the guardian's signed-in Telegram, Rome's mailbox. What a platform calls a bot is one of these accounts, and these docs call it an account. It is the same kind of identity as the [account](people.md#account) on the person's side of a message, except that Rome holds a connection to it. Every [message](#message) reaches Rome through one of Rome's accounts or through the chat built into the dashboard.

**Contracts:**

- Every inbound message reaches routing in one shape, whatever platform it came from. The code layer that absorbs each platform's wire format is called a *channel* ([Channels](../architecture/channels.md)), so adding a platform changes nothing downstream.
- Connecting an account is uniform: every account is connected through the same server-owned setup protocol, and there is no bespoke per-service connect flow ([setup invariants](../architecture/channels.md#connection-setup)).
- Each account's credentials are kept separate and are revoked independently.
- An account Rome holds has a stable id, and stored messages name it. A Telegram, Discord or Feishu account, or the signed-in Telegram user, that connects gets an opaque id, so it never shares an id with an account that came before it. An account connected before accounts were recorded keeps the service's name, which its stored messages spell, and so does the first account of a service that takes no agent. An account exists only while it is connected, and one that connects again starts with no history. An id never passes to another service. One platform can carry several of Rome's accounts, such as two Telegram accounts made for two agents and the guardian's signed-in Telegram ([ADR](../adrs/channels-and-connectors-are-one-connection.md#amendment-2026-10-15-several-connections-per-service)).
- An account has at most one agent, which answers in its chats unless a chat chose its own. The guardian links an agent to an account, switches it, or unlinks it, and main is linked like any other agent. Rome listens to an account that takes an agent only while it has one: a message to such an account with no agent forms no conversation and is not recorded, though Rome can still send as the account. An agent can be linked to any number of accounts, several on one platform included ([An account's agent](../architecture/channels.md#an-accounts-agent)).

**Not to be confused with:**

- **[Message](#message)** — the message is what was said. One of Rome's accounts is what it arrived through.
- **[Person](people.md#person)** — one of Rome's accounts is where a message arrives. The person is who sent it, resolved across accounts.
- **Platform** — the platform, such as Telegram, holds the chats and everyone's accounts. Rome stores a fixed platform for each of its accounts, mapped from the service and, for a Feishu app, from its domain. A Telegram account made for an agent and a signed-in Telegram user are one platform. Feishu and Lark are two, since one account cannot sign in to both.
- **Connection** — a connection is the access the guardian granted to an account. A connection that can talk carries exactly one of Rome's accounts. The same connection to Slack can also let Rome act on the workspace without messaging anyone.
- **Channel** — the code's name for the layer that carries an account's messages ([Channels](../architecture/channels.md)). It is not something the guardian sees or manages.
- **[Hook](apps.md#hooks)** — the `channel-message` hook is how an inbound message enters app code. One of Rome's accounts is where the message came from.

## Policies

The policy engine decides how to handle each incoming message based on who sent it and where.

Evaluation order (first match wins):
1. **Sender-specific** — exact [person](people.md#person) match
2. **Thread-specific** — thread name + type match
3. **Sender tier** — [bond level](people.md#bond-levels) match
4. **Account-specific** — match on one of [Rome's accounts](#romes-accounts). A policy on a later account's own id wins, and a policy on its service covers it otherwise
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
