# Conversational input uses provider-native, non-interrupting steering

- **Status**: Accepted
- **Date**: 2026-08-27
- **Concept**: [conversational inputs](../concepts/sessions.md#conversational-inputs)

## Context

Serializing every user message as a new turn prevents a guardian's correction from reaching an agent that is still using tools. Interrupting the agent cannot undo those tools' effects. Codex app-server and Claude Agent SDK both accept additional input during execution, but their acknowledgement and turn-boundary behavior differ.

## Decision

WebChat submits independently identified inputs to a session-owned input lane that attempts provider-native, non-interrupting steering. The lane starts follow-up turns for undispatched or definitively deferred inputs, never for unknown deliveries.

## Alternatives

- Keep all user messages in the turn FIFO: safe but cannot correct ongoing work.
- Interrupt and replace: interrupts useful work without retracting side effects.
- Retry every unconfirmed steer: can duplicate an input that the provider already accepted.
- Keep a late Claude loop inside the old Rome turn: obscures run boundaries and tool attribution.

## Consequences

A run may consume multiple independently persisted user messages. Receiving a message does not promise immediate consumption. An idle lane reserves a turn synchronously. Only one unconsumed steering input is dispatched at a time, preserving the order of a burst of messages.

Codex uses `turn/steer` with the expected native turn id and `clientUserMessageId`. A completed user-message item confirms consumption. The initial user-message confirmation gates steering because a `turn/start` acknowledgement can arrive before the native turn accepts additional inputs.

Claude uses the existing streaming prompt with a UUID and `priority: next`. Replayed user messages confirm inclusion. An input retained beyond a result starts a separate Rome turn. A `UserPromptSubmit` gate prevents that native loop from executing before its new Rome owner exists. Adoption does not enqueue the input again.

Provider-retained continuations precede independent queued work so an SDK cannot execute that continuation under another caller's turn. Independent `sendTurn` callers remain FIFO relative to one another and keep one result per call. Guardian direct-message handlers use run-owned [channel delivery](../architecture/channels.md#guardian-reply-delivery). Other external-channel handlers retain independent turn calls.

Unknown deliveries, including unfinished inputs after a backend restart, remain visible and are not automatically replayed. Stop targets one active turn and leaves later inputs intact. Provider upgrades must revalidate consumption events and the native startup gates.
