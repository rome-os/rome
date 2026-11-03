# A concurrent turn queues behind the running turn instead of interrupting it

- **Status**: Superseded for WebChat inputs by [provider-native conversational steering](provider-native-conversational-steering.md). Retained for independent turn callers.
- **Date**: 2026-08-11
- **Concept**: [sessions](../concepts/sessions.md)

## Context

A [session](../concepts/sessions.md) is the one live object for a conversation, and several callers reach it. The WebChat route, the channel adapters, approval continuations, and scheduled resumptions all push turns into the same session. A second turn therefore arrives mid-turn in ordinary use. Two browser tabs sit on one chat, a guardian types again during generation, or an approval resolves at the moment a fresh message lands.

The industry default for a chat product stops the running generation and starts over with the second input. That default holds when the discarded work is text. A Rome [turn](../concepts/sessions.md#turn) issues tool calls that leave the process: a message sent on a channel, a file written, an event scheduled, an approval shown to the guardian. Those effects have already landed when the second input arrives, and an interrupt retracts none of them.

The session is also the only place a rule like this holds for every caller. A rule that lives in one entry point covers the callers routed through that entry point, and new entry points keep arriving.

## Decision

A turn that arrives while another turn runs on the same session queues behind it in arrival order and starts once the running turn settles. No caller pre-empts a running turn.

## Alternatives

- **Interrupt the running turn and replace it with the new input, the industry default.** Rejected because a Rome turn's side effects are irreversible. The channel message is sent and the approval sits on the guardian's queue. The replacement turn then opens against a world it has no record of changing.
- **Add an atomic interrupt-and-send primitive to the session.** Rejected because it hands every caller the power to pre-empt every other one. The extra surface each caller must reason about buys nothing back, because the discarded turn's effects still stand.
- **Reject a turn that arrives mid-turn and make the caller retry.** Rejected because a turn the backend starts has no one to press retry. An approval continuation or a scheduled resumption would be dropped rather than delayed.
- **Rank callers so an approval continuation jumps ahead of a guardian turn.** Rejected because the model reads the conversation as a sequence. A priority rule makes transcript order depend on which caller won a race, so the same inputs produce different histories.
- **Keep the arrival order in each entry point instead of the session.** Rejected because a queue outside the session orders only the callers that opt into it. Any caller holding the session still races the rest.
- **Let an interrupt drain the queued turns as well.** Rejected because Stop names the turn the guardian is watching. A turn queued behind it would become collateral damage of a decision about something else.

## Consequences

Every caller gets one rule, and each turn reads a settled world. The running turn's tool calls finish before the queued turn starts, so a turn never opens on top of half-applied work. Transcript order matches arrival order, which keeps a trace reproducible. A turn gets its id at the moment the session accepts it, so a client can name and follow a turn that has not started yet. A queued turn survives a Stop pressed on the turn ahead of it, because Stop names one turn id.

The cost falls on the guardian who wants the replacement behavior. "Stop, then send" costs an explicit Stop and a second submit, and the replacement turn still starts only once the stopped turn settles. A queued turn also waits out the running turn, so a slow tool call delays the message the guardian just typed. No caller marks its turn as urgent.

A transport that owns a delivery stream still sequences its own streams. The WebChat route holds a turn the backend starts until the running turn's stream closes, so the guardian watches one stream at a time. That queue orders delivery, not turns — the session remains the only place turn order is decided.

Future diffs must respect:

- A new entry point pushes its turns through the session queue. No path pre-empts a running turn.
- A transport reports a mid-turn arrival as an accepted turn, not as a conflict.
- An interrupt names one turn and stops that turn alone. Draining the queue is a separate and explicit operation.
- Closing a session fails the turns still queued on it rather than running them.
- A "stop and replace" affordance in a client composes Stop with a send. It adds no implicit pre-emption underneath.
