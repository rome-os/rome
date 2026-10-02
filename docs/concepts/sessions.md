# Sessions

A Rome session is the durable product boundary around one continuous body of agent work. It can represent a guardian-authored chat, an external [channel](messaging.md#channels) thread, an automation, a delegated subagent, a handoff, or a fork. Sessions preserve transcript and trace evidence, so an agent does not restart from a blank slate on every message and background work remains inspectable after it finishes.

**Contracts:**

- For webchat and external IM, one session is the stable conversation. External chats are addressed by their channel and thread: a platform-native thread is a separate conversation, while an ordinary reply remains in its chat.
- The transcript is durable and belongs to Rome, including participant and out-of-band messages the model provider has not seen yet. Provider-side execution state is a separate, re-derivable resource — losing it never loses the conversation.
- A conversation does not expire because it is idle. Rome may evict in-memory session objects to release resources, but the next message resumes the same conversation and the same provider thread.
- Only an explicit product boundary — New Chat, or entering another platform-native thread — creates another conversation. An ordinary reply never does.
- Provider compaction manages the live context window without deleting Rome's durable transcript.
- Usage belongs to the session that executed it: a first-class child subagent session owns its own [turns](#turn) and accounting, and the parent session does not duplicate that usage. Parent/child sessions are linked and appear as session lineage.
- Project attribution matches the session's project directory (exact path or child path). A project's display name is metadata, not an attribution fallback. Forks and subagents inherit the parent's project. Sessions created without project context stay unattributed.

**Not to be confused with:**

- **[Turn](#turn)** — a turn is one unit of work inside a session. A session is the durable boundary around many turns.
- **[Forked turn](#forked-turns)** — a fork branches from a session's context but can never mutate it.
- **Provider execution state** — the provider-side thread is an implementation resource the session resumes. The session is the product boundary.

## Model pin

A session remembers the concrete model that produced its history — the **session model pin** — and requests exactly that model on every later turn and resume ([ADR](../adrs/pinned-session-model-fails-closed.md)). Because a pinned session does not drift to another model on its own, its conversation stays reproducible and its prompt cache survives an entitlement or setting change mid-thread.

**Contracts:**

- A successful turn establishes or updates the pin. A pinned session never drifts to another model on its own. A session with no pin resolves from the agent's exact `modelId`, when configured, or its tier until its next successful turn records a pin.
- Resolution precedence for a turn is **explicit guardian selection → session pin → agent modelId → agent tier**. An explicit model selection (the webchat model selector) wins over both pins, and the successful turn then re-pins the session to the model that actually ran. Choosing a model is therefore the rescue path for a session stranded by a pin whose model cannot run.
- A pinned model is **fail-closed**: if it cannot run (logged out, quota-exhausted, or entitlement lost), the turn fails with a structured resolution error rather than silently substituting another model. Recovery is an explicit selection, or a new session whose configured model is available.
- A new session — including a summoned or subagent session on a shared thread — resolves from its own agent's exact model or tier, because session lookup is agent-scoped. A fork inherits the live session's model unless its caller supplies a tier override, and never updates its source session's pin.
- Changing an agent's configured `modelId` does not rewrite a saved session pin. The changed default applies to new or unpinned sessions.
- Each successful model turn also records the reasoning effort it ran with, as the provider reports it and in the provider's own terms (for example Claude's `max`, Codex's `xhigh`). Webchat shows that value beside the pinned model, without mapping it to the composer's effort labels. The recorded effort is for display only and never seeds a later turn's effort, which each turn still takes from its own request or the agent's configured effort.

**Not to be confused with:**

- **Provider pin** — an [agent](agents.md) may pin a *provider* while still letting a tier select the concrete model.
- **Agent model pin** — `provider` with `modelId` supplies an exact default for a new or unpinned session. The session model pin records the model that produced existing history and takes precedence over that default.
- **Model tier** — the portable agent-level default the session pin overrides once a turn has run.

## Turn

A turn is one request to an agent plus the agent work that follows until the agent answers or stops. The request comes from a user, from a system continuation such as a deferred task, an approval resumption, a timer, or a backend action, or from a provider-started wake. Each turn has a turn id, and usage reporting counts and aggregates turns.

*Deprecated alias:* **Agent run** — surfaces that still say "agent run" for this unit mean a turn. On session and usage surfaces, a bare "run" also means a turn.

**Contracts:**

- Usage reporting counts the user inputs, assistant output, and trace evidence of one turn once, not once per input. A turn can consume more than one user input.
- Failed and interrupted turns still count as turns.
- Stop targets one turn and requests provider cancellation. Until that turn ends, Stop can be retried. Accepting the request does not mean execution has ended.
- Stopping preserves received text and tool evidence, including partial replies. It does not roll back changes. A tool call without a received result has an unknown outcome, not a guarantee that nothing ran.
- Cancelling provider execution does not close the conversation. The next message opens usable execution state and resumes available history without replaying the cancelled message.
- A turn's outcome and wall-clock duration come from the [event](#event) that closes it, and its model attribution and token cost come from the accounting on its terminal event. Neither is read from fields mirrored onto individual messages.

**Not to be confused with:**

- **[Session](#sessions)** — a session accumulates many turns. A turn is one unit of work inside it.
- **Step** — a single model call inside a turn. A turn that uses tools takes several steps, because each tool result feeds the next model call.
- **Run** — an action run is one execution of an [action](actions.md), and a routine run is one fire of a [routine](data.md#routines). Neither is a turn.

## Event

An event is one item of a turn's stream, as Rome publishes it to its consumers. Events fall into four groups:

- **Block events** carry a completed [block](#block).
- **Delta events** carry a [delta](#delta) of a block that is still being produced.
- **Lifecycle events** mark the turn's edges and progress: its start and end, the status of each user input, and the terminal result or error.
- **Other events** report plan updates, structured output, and subagent activity.

*Deprecated alias:* **Agent message** — surfaces that still call an item of a turn's stream a "message" mean an event.

**Contracts:**

- A turn's stream opens with its start event and closes with its end event.
- A turn's stream normally carries one terminal event, the result or error, before its end event. A turn can end with no terminal event, for example when the user stops it, and the end event then reports how it ended.
- The durable trace keeps every event of a turn except delta events and input-status events.
- Delta events never open, close, or reorder a turn.

**Not to be confused with:**

- **[Message](messaging.md#message)** — a message is a conversation entry that a person or an agent sends. An event is an item of one turn's stream.
- **[Block](#block)** — a block reaches consumers as a block event, except a subagent call's tool use and tool result, which normally reach them as subagent start and result events. A subagent call with no linked execution reaches them as a plain tool use and tool result. Results, errors, plan updates, and subagent reports are events that are not blocks.
- **Event-bus event** — something that happens in Rome that a [routine](data.md#routines) or a hook can react to. It is not part of a turn's stream.
- **[Routine](data.md#routines)** — surfaces that say "events" for scheduled automation mean routines, not turn events.
- **Segment** — a display group of a turn's trace events. It groups events and is not one itself.

## Block

A block is one completed piece of model content inside a turn: text, thinking, a tool use, or a tool result. Blocks are the content the model produced or received. Everything else in a turn's stream is an [event](#event) about the turn.

**Contracts:**

- A tool use block is identified by its tool-use id, and the tool result that answers it carries the same tool-use id. For a subagent call, the subagent start and result events that stand in for those two blocks carry the same tool-use id.
- A text or thinking block is identified by its block id when the provider adapter can derive one from the provider's own identifiers. The id is opaque, and a block for which the adapter cannot derive one has none. Rome never borrows another block's id for it.
- A block has at most one identity, unique within its turn: a block id or a tool-use id, never both.
- Provider-native units are translated into blocks and events at the provider adapter. Nothing outside the adapter depends on a provider's own unit.

**Not to be confused with:**

- **[Event](#event)** — a result, an error, a plan update, or a subagent report is an event, not a block.
- **Message part** — a piece of a stored conversation [message](messaging.md#message). A text part can hold the text of a text block, but parts belong to the conversation and blocks belong to a turn.
- **Content block** (Anthropic) and **item** (Codex) — the providers' own units, which Rome translates into blocks and events.

## Delta

A delta is an increment of a [block](#block) that is still being produced: a few tokens of text or thinking, a piece of a tool's input, or a chunk of a running command's output.

**Contracts:**

- A delta is transient. The durable trace, persistence, and accounting never keep it.
- A delta carries the identity of its block whenever the block has one: the block id of a text or thinking block, or the tool-use id of a tool use and its result. A consumer can match a delta to its block by that identity, without relying on event order.
- A text delta whose block has no id belongs to the text block in progress, which a consumer finds by stream order.
- The completed block normally follows its deltas. A turn interrupted or failed mid-block can end without it.

**Not to be confused with:**

- **Chunk** — a whole partial response object that some provider APIs stream. A delta belongs to a single block.
- **Preview** — what a surface shows while a block is in progress. The delta is the data a preview is built from.
- **Fragment** — any partial piece of something. A delta is the specific increment of one block that Rome publishes in a turn's stream.

## Conversational inputs

A conversational input is one independently submitted user message. Its identity remains the same whether it starts a turn or joins one already in progress.

**Contracts:**

- WebChat persists an input before dispatch. Sending during a turn attempts non-interrupting provider steering. It does not start a concurrent turn or replace the active output stream.
- Provider acceptance and consumption are distinct. An accepted input is not shown as consumed until the provider includes it in context.
- A definitely unconsumed input can start the next turn. If the provider already holds it, the next turn adopts it without sending another copy.
- An uncertain delivery is not automatically retried. After a backend restart, unfinished inputs remain visible with unconfirmed delivery. They are not silently replayed.
- Stop targets the specified running turn. It cannot stop another turn, and it does not cancel separately queued inputs.
- Independent action, approval, and external-channel callers retain their serial, one-result-per-call turn contract. They do not implicitly opt into the WebChat input lane.

**Not to be confused with:**

- **Output streaming** — incremental assistant output says nothing about whether new input can join an active turn.
- **Interrupting** — steering changes a later model step without cancelling an in-flight tool or model request.

## Owning app

The owning app is the app that owns the agent attached to the session. Core agents are owned by Rome.

**Contracts:**

- Every turn has at most one owner, so grouping usage by app cannot double-count. Apps whose tools happen to be invoked inside a turn are evidence in that turn's trace, but they are not additional owners.
- Ownership is resolved from the live agent catalog. If the agent is missing from the catalog because its app was removed, the session remains inspectable under **Uninstalled App**. Rome does not persist a second owner snapshot.

**Not to be confused with:**

- **Apps invoked in a turn** — an app whose action ran inside a turn appears in the trace but is not the owner. Only the agent's owning app is.

## Forked turns

A forked turn is a side conversation branched from a live session's full context: the fork sees everything the source conversation has seen, but nothing it does can mutate the source.

The caller creating the fork chooses one of two modes:

- **Isolated** (the default) — the fork opens with an empty tool surface: no actions, skills, subagents, or builtin tools. It can only read the inherited conversation and answer. This is the right mode for side-channel turns that must not act.
- **Exact** — the fork opens with the source session's exact configuration, so the conversation prefix the model sees (system prompt, tool catalog, transcript) is identical to the source. Tools remain callable. Anything the fork executes is attributed to the fork's own session and turn — never the source's — and subagent output streams into the fork, not the source conversation. This is the mode for branch-style features that need the fork to behave as a true continuation of the conversation.

The caller also chooses how long the fork's provider branch lives:

- **One-shot** (the default) — the provider branch is disposable. It closes when the single turn completes, and nothing can resume it. Recap and turn-feedback forks run this way.
- **Continuable** — the caller asks for a provider thread of its own and Rome pins an agent session to it when the turn completes. Later turns resume that thread, so the fork becomes a conversation the guardian can keep talking to.

**Contracts:**

- In both modes the source conversation is untouched: its next turn never sees the fork's prompt, output, or tool calls.
- The fork's model is the caller's choice in both modes: it follows the source's live model unless the caller overrides the tier. Exact-mode callers that want provider prompt-cache reuse keep the source's model. A fork never writes a [model pin](#model-pin) onto its source. A continuable fork records provider and model on its own agent session, which is what a later turn resumes from. It also records the reasoning effort its turn ran with, for display only.
- A turn can be forked only after it completes successfully and Rome persists that exact turn's provider checkpoint. Running, stopped, failed, and checkpoint-less turns are not forkable. Rome never substitutes another turn's transcript head or reconstructs provider history from visible output.
- Every forked turn is recorded as its own fork session, linked back to the parent session and the turn the fork branched from, so its trajectory can be inspected like any other turn.
- A fork is continuable only when it completed on a provider thread of its own. A branch whose turn errored, and one whose provider ran it inside the source thread, stay one-shot and read-only.
- A fork holds no scheduled wake-ups and hosts no approval continuation, continuable or not. Both resume through the top-level session host, which answers into the conversation that scheduled them.

**Not to be confused with:**

- **Subagent session** — a subagent is delegated work that reports back to its parent. A fork is a side conversation whose output never reaches the source session's next turn.
- **New session** — a new session starts from a blank slate. A fork inherits the source's full context.
