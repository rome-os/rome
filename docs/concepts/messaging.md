# Messaging: Messages, Conversations, Channels, Policies, Sentinel, Approvals

## Message

A message is one thing somebody said — a line a person sent to Rome, or one Rome sent back, with whatever came attached to it. It travels on a [channel](#channels), from or to an [account](people.md#account).

**Contracts:**

- Every message names the account that sent or received it and the channel that carried it. Who that account belongs to is the account's [link](people.md#link), so who said something changes only when a link does, retroactively and over their whole history.
- A message goes one of two ways: to Rome, or from it. Every message declares which, and there is no third direction.
- A message is what was said, which is not the same as what Rome holds. A platform that keeps its own record has the conversation back past the point Rome started watching. Where Rome keeps the only record, the history starts when Rome did.

**Not to be confused with:**

- **[Channel](#channels)** — the channel is what carried a message. The message is what was said on it.
- **[Conversation](#conversation)** — the conversation is the thread a message was said in. The message is the one line.
- **[Account](people.md#account)** — the account is who said it. The message is what they said.
- **Notification** — a notification is an out-of-band delivery to the guardian. It lands in the same transcript, but nobody sent it on a channel.

## Conversation

A conversation is the thread a [message](#message) was said in, named by the platform's own id for it. Every message belongs to exactly one.

**Contracts:**

- A direct conversation is addressed by the person on it. A group conversation is addressed by the group and by nobody on it, so no account names one and no read scoped by an account reaches one.
- A conversation belongs to the [channel](#channels) that holds it. Two channels are free to spell an id the same way and mean two different threads.
- What a conversation holds and what passed between Rome and a person are two questions to one store, not two histories: a channel answers both from the record it already keeps.

**Not to be confused with:**

- **[Account](people.md#account)** — the account is who Rome is talking to. The conversation is where they said it. On a direct thread the two are named by one string; on a group they are not.
- **Session** — a session is Rome's own working context for a thread. The conversation is the thread itself, which exists whether or not Rome ever opened a session on it.

## Channels

A channel is somewhere Rome and a person can reach each other — WhatsApp, Telegram, email, the chat built into the dashboard. Every [message](#message) arrives on one, and everyone Rome can talk to is reached through one. The platform owns the channel. Rome connects to it.

**Contracts:**

- Every inbound message reaches routing in one shape, whatever platform it came from. A channel absorbs its own platform's wire format, so adding a channel changes nothing downstream.
- Channel connection setup is uniform: enabling any channel drives the same server-owned setup protocol — there is no bespoke per-service connect flow ([channel invariants](../architecture/channels.md#invariants)).
- Per-channel credentials are kept separate and are revoked independently.

**Not to be confused with:**

- **[Message](#message)** — the message is what was said. The channel is what carried it.
- **[Person](people.md#person)** — a channel is where a message arrives. The person is who sent it, resolved across channels.
- **Connection** — a connection is what joins the Rome instance to a service, holding the authority the guardian granted. Carrying messages is one of the things that authority buys. The same connection to Slack can also let Rome act on the workspace without messaging anyone.
- **[Hook](apps.md#hooks)** — the `channel-message` hook is how an inbound message enters app code. The channel is where the message came from.

## Policies

The policy engine decides how to handle each incoming message based on who sent it and where.

Evaluation order (first match wins):
1. **Sender-specific** — exact [person](people.md#person) match
2. **Thread-specific** — thread name + type match
3. **Sender tier** — [bond level](people.md#bond-levels) match
4. **Channel-specific** — [channel](#channels) match
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

- All sentinel decisions are recorded. The main agent periodically reviews the log (cadence configurable) to catch anything that needs follow-up.
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
