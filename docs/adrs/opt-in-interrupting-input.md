# An input may opt in to interrupting the running turn

- **Status**: Accepted
- **Date**: 2026-10-25
- **Concept**: [conversational inputs](../concepts/sessions.md#conversational-inputs)

## Context

[Queued turns over interrupt and replace](queued-turns-over-interrupt-and-replace.md) and [provider-native conversational steering](provider-native-conversational-steering.md) keep a running turn alive when a new input arrives, because an interrupt cannot retract the turn's tool effects. That holds for an agent that works inside its own turn.

A texting-style agent such as Concierge does no heavy work itself. Its turn says a few lines and starts task chats, which run in sessions of their own and survive its interrupt. Its guardian expects to be heard at once. Steering lands only after the current model call ends, and a prototype on both providers showed 5 to 6 stale lines per interruption that way.

## Decision

A WebChat input carries a priority: `next`, the default, keeps steering, and `now` ends the running turn and starts a new one with the input. The session implements `now` at the Rome turn level. It seals the input lane, interrupts the turn with the reason `superseded`, and starts the next turn once that turn settles.

When a superseded turn ends, each of its inputs the provider never consumed goes in front of the next turn's prompt, in order. The next turn also takes every other queued `now` input. A guardian Stop still never replays.

## Alternatives

- **Pass `now` to the provider.** Rejected because Claude's `now` aborts inside one Rome turn, so one Rome turn would span two provider turns and each provider would need its own turn-boundary bookkeeping.
- **Interrupt for every input of a Concierge chat, keyed on the agent.** Rejected because core then names one agent. The caller states the priority on each input.
- **Drop the unconsumed inputs of a superseded turn.** Rejected because Claude resumes from its transcript after a hard abort, and an input sent during the turn's startup is not in that transcript yet.
- **Give each queued `now` input its own turn.** Rejected because each would interrupt the one before it, and a burst of three messages would start and abort two turns.

## Consequences

A `now` input reaches the model after one interrupt and one turn start, not after the current model call. On Claude that start respawns the CLI and resumes the transcript.

A superseded turn's tool effects stand, as with any interrupt. A caller opts in only where a turn's effects are cheap to cut short. The default stays `next`, so every existing caller keeps the contracts of the two earlier decisions.

Future diffs must respect:

- An input without a priority behaves as `next`.
- Only an interrupt with the `superseded` reason carries unconsumed inputs forward. Stop never does.
