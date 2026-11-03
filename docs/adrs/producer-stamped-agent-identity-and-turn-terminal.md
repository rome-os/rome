# Agent identity and turn boundary are stamped in-band by the producer, not inferred from stream closure

- **Status**: Accepted
- **Date**: 2026-08-11
- **Concept**: [Sessions — Turn](../concepts/sessions.md#turn)

## Context

A session's blocks are one flat list, streamed live and stored for replay, and that list accumulates every turn the session ever ran. A consumer of the list has two questions to answer: which agent produced this block, and where does one turn start and end. The content blocks answer neither. Several of them can sit last in the list, and a turn that failed before the model ran looks from the outside like a turn still in flight.

The runtime that produces the blocks is the only place that holds both answers. It knows the name of the agent whose stream it is pumping, and it knows which of its exit paths closed the turn. A turn can end through a clean provider terminal, a provider crash, a lock failure, a forced close of the events loop, or a failure that fires before the model is reached at all. The producer also holds the outcome classification, because a user stop is an interruption even when the provider surfaced the abort as an error block. Every one of those facts is inside the producer and invisible to anyone reading the blocks afterward.

The stream has three readers with different shapes. A live reader watches the turn over SSE and can observe the sink closing. A replay reader loads the same turn from the database, where there is no stream and no closure to observe. Usage analytics is a SQL query over stored blocks with no stream at all. All three have to reach the same answer about the turn, because the guardian compares what they watched against what they reload.

Duration has two meanings that a single field cannot hold. Per-block `accounting` describes one model call — its provider, model, token usage, cost, and the duration that provider reported. Cost and usage rollups sum that field across blocks. The turn's wall clock is a different quantity, measured by the session across the whole turn, and only the producer measures it.

An [agent run](../concepts/sessions.md#turn) is one turn, so a reader that cannot place the turn's edges cannot report the run. Ordering does not supply those edges: a terminal arriving last is a property of one execution shape, not a contract. A [subagent runs in its own child session](child-session-owns-subagent-stream-and-cost.md), so a parent turn's edges have to be marked rather than deduced from whatever the parent's list happens to end with.

Two mechanisms have carried this decision. The original design chose a `turnTerminal` boolean on the existing `result`/`error` block and rejected a separate message for the boundary. The shipped system carries it as an explicit `turn_start`/`turn_end` bracket instead, and no `turnTerminal` field remains. This record documents the standing decision — the producer marks identity and the turn boundary in-band — and the bracket that now carries it. The marker sits below as the alternative that implementation experience overturned, so a reader arriving from that design can see which part survived.

## Decision

The producing runtime stamps every emitted message with the name of the agent that produced it, and brackets every turn in band with a dedicated pair of lifecycle blocks. `turn_start` is the first block of a turn's stream and `turn_end` is the last, carrying the turn id, the producer's outcome classification, and the turn's wall clock. Consumers read agent identity and turn boundaries from the blocks themselves, never from stream closure, block order, or a default applied at the consumer.

## Alternatives

- **Signal the end of the turn out of band, through sink or SSE closure or a `done` event.** Rejected because a persisted turn read back from the database has no stream to close. The replay path cannot separate a turn that finished cleanly from one that crashed mid-turn, so a reload renders a turn differently from how the guardian watched it. The SSE `done` event stays as a transport convenience and reads its stopped and failed flags off the in-band bracket.
- **Mark the boundary with a flag on the terminal `result` or `error` block.** Rejected because a flag on the closing block can only close a turn and never open one, and a consumer has to reset turn-scoped summary state before the next turn's blocks arrive. The flag also carries no turn id, and the turn's outcome is not a property of terminal content — a user stop is an interruption even when the provider reports an error.
- **Flag the existing terminal block with a `turnTerminal` boolean, the original design.** Rejected because the flag needs a terminal block to ride on, and a turn can end without one — a forced close or a crash leaves nothing to carry the mark. It also inverts the default for delegation: a relayed child terminal arrives already flagged, so every relay path has to remember to clear it, and forgetting ends the parent turn early. A bracket opens before the turn's content and closes after it, so it exists whether or not a terminal arrived and is never inherited.
- **Infer the boundary at the consumer as the last `result` or `error` block.** Rejected because "last wins" hands the turn's duration and outcome to whichever provider frame happens to arrive last, and it answers nothing on a partial load where the turn is still running.
- **Infer the boundary at the consumer by matching the block's agent against the session's root agent.** Rejected because it requires every consumer to learn the root agent from somewhere else, and it still fails on a partial load where the last block has not arrived yet.
- **Default the producer at the consumer with `agent ?? "main"`.** Rejected because the literal `"main"` is wrong whenever the turn's root agent is another agent, such as `envoy`. The default also has to be repeated at the runtime, the trace builder, and the display resolver, which leaves the answer with no single source of truth.
- **Carry the turn wall clock in `accounting.durationMs` on the terminal block.** Rejected because that field means the duration the provider reported for one model call. Overwriting it corrupts the cost and latency rollups that aggregate accounting across blocks, and it leaves a turn that ended without a model call with no honest value to write.
- **Give synthetic terminals a placeholder accounting record so one field can carry both meanings.** Rejected because paths such as a forced close have no model call behind them. A fabricated provider, model, and usage row enters every aggregate that sums accounting.
- **Report a duration only on the turn boundary and drop `accounting.durationMs` from terminal blocks.** Rejected because run cards and per-run latency metrics read that per-call number off the terminal, and each child session reports its own. Deleting real per-call data is a wider loss than the fix.
- **Make the agent field required on the published message union in the same change.** Rejected because it is a breaking change to a package other people consume. The break has to land after the runtime has proven it stamps the field on every emit path, not before it.

## Consequences

A consumer answers both questions from the block list alone. The live stream, the reload, and the analytics query report the same outcome and duration for a turn, because all three read the same bracket. Analytics attributes work to the agent that did it. Parallel and background delegation is safe to add, because nothing depends on a child finishing before its parent.

The producer carries a duty it can fail. Every path that can end a turn has to close the bracket, including the crash paths and the failures that fire before the turn clock starts. Those early failures report a zero duration rather than a wall clock measured from the epoch. A producer outside the agent runtime, such as an API route that fails a turn before the session runs, synthesizes the whole bracket itself. A new terminal path that skips the bracket yields a turn with no observable end.

Every stream carries exactly one bracket pair, its own. A [child session](child-session-owns-subagent-stream-and-cost.md) keeps its brackets in its own stream, and the parent sees the delegated work through subagent lifecycle blocks instead.

Two duration fields exist, and picking the wrong one is a silent error. Per-call duration stays on `accounting`, and turn wall clock stays on the closing bracket.

Future diffs must respect four rules. The producer stamps agent identity, so no consumer restores a missing one with a literal default. Every turn stream is bracketed exactly once, opening before any content of the turn and closing after its terminal block. Turn wall clock and turn outcome live on the closing bracket, and `accounting` keeps its per-model-call meaning. The turn's summary values — duration, stopped-by-user, terminal error — derive from the closing bracket, and the terminal block supplies only the error text for a bracket that reports a failure.
