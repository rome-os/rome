# A session runs the model that produced it, and fails closed when that model cannot run

- **Status**: Accepted
- **Date**: 2026-08-11
- **Concept**: [sessions — model pin](../concepts/sessions.md#model-pin)

## Context

An [agent](../concepts/agents.md) names a model tier, and the tier maps to a concrete model through mutable global state: plan entitlements, the Fable setting, provider login, and provider quota. A [session](../concepts/sessions.md) outlives that state. A conversation opened this morning is still open when a plan refresh lands, a setting flips, or a quota window opens.

Resolving the tier on every turn ties the model to whatever the global state says at that moment. One conversation then runs on two models across two of its turns. The transcript records an exchange no single model produced, and the provider backend closes and reopens mid-thread, which throws away the prompt cache built over the conversation.

The model that produced a thread also has to survive a resume. A session that comes back on a different model than the one that wrote its history reads its own transcript as another model's work.

Unavailability of a specific model is ordinary, not exceptional. A guardian logs out, a quota window opens, or a plan loses access to a tier. Some sessions carry an explicit model selection the guardian made in webchat when the chat opened. Routines and resumable summons run unattended, so nobody is there to answer a prompt or pick a substitute.

## Decision

A session records the concrete model that produced its history and requests exactly that model on every later turn and resume, with an explicit guardian selection as the only thing that outranks it. A pinned model that cannot run fails the turn with a structured resolution error, for transient and permanent loss of access alike.

## Alternatives

- **Re-resolve the tier on every turn and pick up the current entitlements, the behavior the model resolver shipped with.** Rejected because the model a conversation runs on then changes underneath the guardian between two turns of one thread. The switch is invisible in the product, and it costs the prompt cache on every entitlement change.
- **Persist the model as a resume-only seed, then hand later turns back to tier resolution.** Rejected because the drift the pin exists to stop happens between turns, not at resume. A seed fixes the first turn after a resume and lets every turn after it wander.
- **Persist the model as a preference that tier resolution overrides when entitlements change.** Rejected because an entitlement change is exactly the moment the pin has to hold. A preference that yields to the state it was recorded to outlast decides nothing.
- **Fall back to an available model and re-pin the session.** Rejected because a silent substitution changes what model a thread runs on without the guardian knowing, which is the failure the pin exists to prevent. It also rewrites the record of what produced the history, so the substitution leaves no trace to notice later.
- **Split by recoverability: fail closed on transient loss (quota, logged out) and re-resolve when access is lost permanently.** Rejected because Rome cannot tell the two apart at resolution time. A revoked entitlement and a plan that refreshes in an hour arrive as the same denial, so the split turns "never substitute silently" into a guess.
- **Treat the Fable setting as an entitlement, so toggling it off moves pinned sessions off Fable.** Rejected because the setting is a Rome-side preference over new resolutions, and honoring it mid-session is a silent substitution wearing a different name.
- **Prompt the guardian for a substitute when the pinned model cannot run.** Rejected because unattended sessions have no guardian to ask. A routine turn would block on a prompt nobody sees, which is a worse failure than an error the caller can read.

## Consequences

A session never changes model on its own. A conversation stays reproducible against the model that produced it, and a mid-thread entitlement change leaves the prompt cache intact. Model resolution collapses to one precedence rule that every path shares, so a resume needs no special guard of its own.

The guarantee covers automatic drift, not every turn of a session. An explicit guardian selection runs the same session on another model and re-pins the row. The row therefore names the model the next turn requests, not the model behind every past turn. Attribution for a past turn comes from that turn's terminal accounting, which records the provider and model that ran (see [turn](../concepts/sessions.md#turn)).

A session does not pick up a new entitlement or setting. Fresh entitlements reach fresh sessions, which surprises a guardian who expects an upgrade to reach an open chat. During a quota window a pinned session fails its turns rather than moving to another provider for a turn. Webchat fixes a conversation's selection when the chat opens, so an open chat has no selector left to reach for. A session pinned to a model whose access is gone for good is stranded, and every turn on it fails until a caller starts a new session. Rome takes that cost to keep "never substitute a model silently" absolute.

Future diffs must respect:

- Every model resolution path — turn, resume, summon, webchat — reads the pin ahead of the agent tier. A new path is not exempt.
- An explicit guardian selection is the one input that outranks the pin, and the successful turn re-pins the session to the model that ran. It is the only input that moves a session onto another model, so no diff may remove that precedence without a replacement.
- A caller that cannot supply a selection has no recovery path, and that is the intended shape rather than a gap. Webchat resolves a conversation's selection when the chat opens and keys the thread on it, so an open conversation reaches the precedence above only by starting a new one. A routine or resumable summon has no guardian to ask at all.
- A pinned model that cannot run raises a structured resolution error. No path substitutes another model, retries against a different provider, or clears the pin to make a turn succeed.
- A fork opens on the caller's resolved model — the live session's model unless the caller passes a `tier` override — and writes no pin either way. A summoned or subagent session resolves from its own tier, because session lookup is agent-scoped and pins never cross agents.
- A session with no pin resolves by tier and records one on its next successful turn.
