# A subagent runs in a child session that owns its messages and cost — the parent gets one completion

- **Status**: Accepted
- **Date**: 2026-08-11
- **Concept**: [Sessions — Turn](../concepts/sessions.md#turn)

## Context

A subagent is delegated work. The parent agent calls a subagent tool, the child agent runs its own turn against its own provider thread, and the parent reads the answer. Rome already gives that child a separate runtime session, so the split exists in the runtime before anything is stored or delivered.

Delivery is where the split can collapse. The common shape for nested agents relays child events into the parent stream, so the guardian watches nested progress inline in the parent conversation, and rolls child token usage into an inclusive parent total. Both moves put child data under a parent owner.

Four forces push the other way. First, only the parent terminal may become the guardian-facing reply, and a stream carrying both parent and child terminals lets a child result stand in for a parent that failed after it. Second, a trace holding child text and tool calls without a complete child lifecycle has no durable parent-child relation, so the trace UI reconstructs structure from agent tags and event adjacency. Third, global usage sums every stored accounting row, so a stored inclusive parent total is correct only while children own no [turns](../concepts/sessions.md#turn) of their own. It double-counts the moment they do. Fourth, `/sessions` is the debugging surface for every session, and a child that a parent swallowed is not inspectable there.

Two constraints bound the answer. The model-facing subagent tool stays blocking and keeps one input shape, so the child cannot become an interactive handoff by accident. The parent-child relation has to survive a browser refresh and a completed turn, while an in-flight child cannot survive a Rome process crash at all.

[Sessions](../concepts/sessions.md) carries the resulting invariant.

## Decision

Every subagent invocation runs in a first-class child session that owns its transcript, trace, stream, status, and accounting. The parent stores a reference to the child session and turn plus one structured completion as the tool result, and nothing else the child produced.

## Alternatives

- **Relay child events into the parent stream and trace.** Rejected because the ownership question then moves to every downstream consumer: the reply collector, the trace segmenter, the SSE projection, and usage all have to re-separate parent from child on each read. The failure it produces is concrete — a successful child result survives as the last collected result when the parent turn fails after it, and the guardian reads a child answer as the parent reply.
- **Keep the flattened stream and separate the two with agent tags or a copied child summary.** Rejected because a tag is presentation and does not give a child event an owner. A copied summary also has to be kept in sync with the child it copies, and copied accounting reopens the double-count.
- **Render child commentary and final text in the parent chat so nested progress stays visible.** Rejected because internal delegation and an interactive handoff would collapse into one product. A child that speaks in the parent conversation needs a guardian-facing surface with its own governance, which is a different feature.
- **Store an inclusive total on the parent's accounting row.** Rejected because the child owns trace accounting of its own, so a stored parent total that already contains its descendants counts the same usage twice in global totals. The inclusive figure is instead a read-time walk over the parent's own subagent references, so the guardian still gets it without a stored copy.
- **Reuse an idle child session implicitly when the agent and thread match.** Rejected because one delegation would then inherit provider history from an unrelated earlier delegation that the parent never asked for. The same call would produce different results depending on what ran before it.
- **Let any parent holding a child session id resume that child.** Rejected because the id becomes cross-session shared state, and permissions, deletion, and trace presentation all lose a single answer for who owns the child. Resume stays restricted to the parent recorded on the child.
- **Cascade-delete child sessions when the parent is deleted.** Rejected because the evidence for why a parent turn went wrong usually lives in the child, and deleting a parent is exactly when a reader wants that evidence. Live child execution still stops with the parent, so nothing keeps running unobserved.
- **Persist the active parent-child execution mapping.** Rejected because an in-flight child cannot outlive a Rome process crash, so a durable `running` row records work that no restart can recover. It would leave stale state to reconcile without making the execution resumable.

## Consequences

One trace belongs to one session and one agent. Trace segmentation drops its multi-agent reconstruction, parent reply selection stops needing a same-agent guard, and parent turn metrics count parent tool calls only. Global usage sums every trace accounting row exactly once. Delegation composes to any depth, because a child interrupts its own children the same way its parent interrupts it.

Reading the child's own words costs a hop. The parent trace shows a subagent step carrying the child session and turn. The child transcript and text open in the child session behind it. Trace reads join the child's status, step count, duration, and descendant cost onto that step by default. A cost figure for a parent plus all descendants is a read-time walk over the parent's subagent references, not a field on the parent row.

A child whose parent session was deleted stays readable in `/sessions` but cannot be resumed, because resume requires the original parent. The link for a running child is process-local, so a crash loses the in-flight execution and its parent-side handle. The durable child session and any trace written before the crash remain.

Future diffs must respect three things. No child message, terminal, lifecycle event, or accounting row is written into the parent's transcript, trace, or stream — the parent stores a reference plus one structured completion. Resume stays explicit and parent-scoped, and deletion of a parent stays non-cascading. A new surface that needs parent and child together — analytics, export, a nested view — resolves the lineage at read time instead of copying child data upward.
