# Concierge changes providers when its subscription quota runs out

- **Status**: Accepted
- **Date**: 2026-11-03

## Context

Concierge is one long-lived chat the guardian texts. It delegates work to task chats whose state Rome records. A new provider thread can recover the conversation from stored messages and the task list. A [continuation notice](../concepts/sessions.md#continuation) points a replacement thread to `system:fetch_channel_history`. A provider thread is a cache of the conversation, not its record.

The [session pin](pinned-session-model-fails-closed.md) prevents silent substitution. A quota switch must be visible, even if the next turn fails or Concierge says nothing.

## Decision

**Exception: Concierge quota failover.** When Concierge's current provider is confirmed out of subscription quota, Rome moves that chat to the other eligible subscription without asking. The switch is visible in the chat, and a replacement thread gets a continuation notice pointing to stored messages.

## Alternatives

- **A click-to-switch card.** Rejected because it asks the guardian something Rome can decide, and Concierge can recover its work from its records.
- **Automatic failover for every chat.** Rejected because an ordinary chat's stored messages omit its tool calls. A new thread cannot tell what already ran.
- **A silent switch with no notice.** Rejected because silent substitution is the failure the pin exists to prevent.
- **Switch back when quota returns.** Rejected because it throws away a working thread again for no gain.

## Consequences

A Concierge turn can run on another provider with no guardian action. Each switch loses a provider thread, not the transcript. Avoiding repeated work relies on the recovery prompt and the agent checking actual state.

Future diffs must respect:

- Only the fixed Concierge chat qualifies. Ordinary chats, task chats, routines, summons, side chats, handoffs and subagents still fail closed.
- The other provider must be signed in, have quota, need no reauthentication, and use a subscription. An API key or Rome credits never qualifies.
- A generic rate limit, network or auth failure, or single-model limit never triggers failover.
- The host records a visible switch notice independently of the agent's output.
- Recovery reads this chat's stored messages and task list, verifies uncertain work, and asks the guardian before repeating an unconfirmed side effect. Its input carries those instructions even when a first-turn failure left no provider thread to replace.
- An explicit guardian selection and this exception are the only inputs that move a session onto another model. Quota recovery does not switch back merely because the preferred provider's quota returns.
