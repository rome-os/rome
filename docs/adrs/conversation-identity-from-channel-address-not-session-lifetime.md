# Conversation identity derives from the normalized channel address, never from provider session lifetime

- **Status**: Accepted
- **Date**: 2026-08-11
- **Concept**: [sessions](../concepts/sessions.md)

## Context

An external chat carries one address that the platform itself keeps stable: the [channel](../architecture/channels.md) and the thread id. A guardian sees one scrollback at that address across days, restarts, and quiet weekends. Nothing in the product tells them that a chat ended.

Rome runs that conversation on a provider session — a Codex or Claude thread — and that resource has a lifetime of its own. Rome evicts idle in-memory session objects to release resources, the host process restarts, and a per-turn timeout kills a stuck turn. Each of those is a resource event, not a product event.

One chat therefore has two identities: the durable Rome conversation and the provider execution state. Deriving the durable one from the provider one turns every resource event into a conversation boundary. An idle chat comes back as a second conversation at the same address, and a reply to yesterday's message lands in a record that does not contain it.

Provider-native history cannot carry the durable record either. Both providers compact their context window, which discards exact wording. Messages that never drove a provider turn never enter that history at all — a group member's remark the agent did not answer, or a notification an action sent out of band. A user replying to one of those messages expects Rome to hold its premise.

Rome already stores both projections. `rome_sessions` holds the product session for a webchat or channel thread, `rome_agent_messages` holds its messages, and `sessions` holds provider execution state. The open question is which of them owns identity, and what decides when a conversation ends.

## Decision

A conversation's identity comes from the normalized channel and thread address: the same address always resolves to the same `rome_sessions` record, and the provider session is a separate projection of that same address rather than the source of it. Rome's own transcript is the durable record of the conversation, and provider-native history is a cache in front of it.

## Alternatives

- **Derive the channel conversation id from the provider session id.** Rejected because the provider session's lifetime answers a resource question — memory pressure, a restart, a killed turn — and the conversation then inherits every one of those answers as a boundary the guardian never asked for.
- **Expire a conversation after an idle timeout, the `sessionReuseTimeoutMinutes` behavior.** Rejected because elapsed time carries no meaning at a chat address. The platform still shows one chat, so the next message is a continuation, and a timeout splits it with nothing in the product to mark the split. Per-conversation provider session reset re-proposed time as a partition key and shipped narrowed to the `session.reset` conversation setting, which rotates the provider generation behind an unchanged address.
- **Give the chat its own `conversations` table, the OpenClaw shape.** Rejected because `rome_sessions` already owns a webchat or channel thread as a product record. A second table gives one address two owners that have to agree about which conversation a message belongs to.
- **Store a reference from the provider session row to the conversation.** Rejected because conversation resolution has to succeed when no provider session exists — the first message at an address, or after cleanup removed the row. A stored reference makes identity depend on the resource whose lifetime it exists to outlive.
- **Fold the bound agent name into the external conversation address.** Rejected because changing the bound agent is an explicit product operation, and folding it into the address turns that change into an implicit conversation split at an unchanged chat.
- **Treat an ordinary reply as a thread and open a conversation for it.** Rejected because a platform without native thread semantics gives a reply no separate scrollback. One chat fragments into a conversation per reply, and none of them holds the chat's context.
- **Keep provider-native history as the conversation record and accept what compaction leaves.** Rejected because compaction discards exact wording, and agent-visible messages that never triggered a turn never reach that history — the two gaps a durable transcript exists to close.
- **Fetch a replied-to message from the platform API when a turn needs it, generalizing the Discord prompt workaround.** Rejected because it works only on platforms that offer a live fetch, depends on the model choosing to call a tool, and assumes the original message stays readable. It also records nothing about what the user actually saw.
- **Replay the full stored transcript into the provider on every turn.** Rejected because it throws away the provider's own context and cache, and the cost of a turn then grows with the length of the conversation instead of with the part the provider has not seen.

## Consequences

A chat survives idle time, a process restart, and in-memory eviction, and the next message resumes the same conversation. The provider thread survives a restart and an eviction as well, and it changes only when the conversation's own reset policy rotates it. A reply resolves against stored messages, so the agent answers with the premise the user saw. Group participants and out-of-band notifications join the durable record without triggering a turn. A new channel adapter supplies a normalized address and inherits continuity instead of inventing an identity scheme. `sessions.last_active_at` measures the age of one provider generation and decides nothing about conversation identity.

Durable storage grows with conversation activity rather than with the provider context window, so retention becomes a policy someone designs in the open. `rome_sessions` stays polymorphic, and a caller reads `type` to tell a conversation from an action, handoff, subagent, or fork session. A long-lived provider thread leans on provider compaction. Clearing a thread that goes bad is its own mechanism: the per-conversation `session.reset` policy, idle seven days by default, which rotates the provider generation and records the rotation.

Future diffs must respect:

- Every conversation-resolution path derives `rome_sessions.id` from the normalized channel and thread address, and resolves the conversation before it gets a provider session. No path derives it backward from a provider session id.
- One address resolves to one active conversation. The lookup that creates a conversation is atomic, so a burst of messages at a new address cannot open two.
- `rome_agent_messages` is the durable record of what happened in a conversation. Provider compaction never deletes or rewrites it, and no path treats provider-native history as the source of truth.
- The conversation and the provider session stay independently derived from the same address. Neither stores a reference to the other.
- Elapsed time never ends a conversation. The `session.reset` policy rotates the provider generation behind an unchanged address, and the conversation record and its messages survive that rotation.
- The bound agent is metadata on a conversation, not part of its address. Rebinding an agent stays an explicit operation.
