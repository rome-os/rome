# Sessions

A Rome session is the durable product boundary around one continuous body of agent work. It can represent a guardian-authored chat, an external [channel](messaging.md#channels) thread, an automation, a delegated subagent, a handoff, or a fork. Sessions preserve transcript and trace evidence, so an agent does not restart from a blank slate on every message and background work remains inspectable after it finishes.

**Contracts:**

- For webchat and external IM, one session is the stable conversation. External chats are addressed by their channel and thread: a platform-native thread is a separate conversation, while an ordinary reply remains in its chat.
- The transcript is durable and belongs to Rome, including participant and out-of-band messages the model provider has not seen yet. Provider-side execution state is a separate, re-derivable resource — losing it never loses the conversation.
- A conversation does not expire because it is idle. Rome may evict in-memory session objects to release resources, but the next message resumes the same conversation and the same provider thread.
- Only an explicit product boundary — New Chat, or entering another platform-native thread — creates another conversation. An ordinary reply never does.
- Provider compaction manages the live context window without deleting Rome's durable transcript.
- Usage belongs to the session that executed it: a first-class child subagent session owns its own [runs](#agent-run) and accounting, and the parent session does not duplicate that usage. Parent/child sessions are linked and appear as session lineage.
- Project attribution matches the session's project directory (exact path or child path). A project's display name is metadata, not an attribution fallback. Forks and subagents inherit the parent's project. Sessions created without project context stay unattributed.

**Not to be confused with:**

- **[Agent run](#agent-run)** — a run is one turn of work. A session is the durable boundary around many turns.
- **[Forked turn](#forked-turns)** — a fork branches from a session's context but can never mutate it.
- **Provider execution state** — the provider-side thread is an implementation resource the session resumes. The session is the product boundary.

## Model pin

A session remembers the concrete model that produced its history — the **session model pin** — and requests exactly that model on every later turn and resume ([ADR](../adrs/pinned-session-model-fails-closed.md)). Because a pinned session does not drift to another model on its own, its conversation stays reproducible and its prompt cache survives an entitlement or setting change mid-thread.

**Contracts:**

- A successful turn establishes or updates the pin. A pinned session never drifts to another model on its own. A session with no pin resolves by tier until its next successful turn records one.
- Resolution precedence for a turn is **explicit guardian selection → session pin → agent tier**. An explicit model selection (the webchat model selector) wins over the pin, and the successful turn then re-pins the session to the model that actually ran. Choosing a model is therefore the rescue path for a session stranded by a pin whose model cannot run.
- A pinned model is **fail-closed**: if it cannot run (logged out, quota-exhausted, or entitlement lost), the turn fails with a structured resolution error rather than silently substituting another model. Recovery is an explicit selection or a new session.
- Forks inherit the live session's model and never write pins. A new session — including a summoned or subagent session on a shared thread — resolves from its own tier, because session lookup is agent-scoped.

**Not to be confused with:**

- **Provider pin** — an [agent](agents.md) may pin a *provider* for capability reasons. The session model pin records the concrete *model* a session's history was produced by.
- **Model tier** — the tier is the agent-level default the pin overrides once a turn has run.

## Agent run

An agent run is one turn of agent work, identified by its turn id — the unit usage reporting counts and aggregates.

**Contracts:**

- The user inputs, assistant output, and trace evidence produced by the same turn count as one run, not several. A run can consume more than one user input.
- Failed and interrupted turns still count as runs.
- Stop targets one run and requests provider cancellation. Until that run ends, Stop can be retried. Accepting the request does not mean execution has ended.
- Stopping preserves received text and tool evidence, including partial replies. It does not roll back changes. A tool call without a received result has an unknown outcome, not a guarantee that nothing ran.
- Cancelling provider execution does not close the conversation. The next message opens usable execution state and resumes available history without replaying the cancelled message.
- A run's outcome and wall-clock duration come from the bracket that closes it, and its model attribution and token cost come from the terminal block's accounting. Neither is read from fields mirrored onto individual messages.

**Not to be confused with:**

- **[Session](#sessions)** — a session accumulates many runs. A run is a single turn.

## Conversational inputs

A conversational input is one independently submitted user message. Its identity remains the same whether it starts a run or joins one already in progress.

**Contracts:**

- WebChat persists an input before dispatch. Sending during a run attempts non-interrupting provider steering. It does not start a concurrent run or replace the active output stream.
- Provider acceptance and consumption are distinct. An accepted input is not shown as consumed until the provider includes it in context.
- A definitely unconsumed input can start the next run. If the provider already holds it, the next run adopts it without sending another copy.
- An uncertain delivery is not automatically retried. After a backend restart, unfinished inputs remain visible with unconfirmed delivery. They are not silently replayed.
- Stop targets the specified running turn. It cannot stop another turn, and it does not cancel separately queued inputs.
- Independent action, approval, and external-channel callers retain their serial, one-result-per-call turn contract. They do not implicitly opt into the WebChat input lane.

**Not to be confused with:**

- **Output streaming** — incremental assistant output says nothing about whether new input can join an active run.
- **Interrupting** — steering changes a later model step without cancelling an in-flight tool or model request.

## Owning app

The owning app is the app that owns the agent attached to the session. Core agents are owned by Rome.

**Contracts:**

- Every run has at most one owner, so grouping usage by app cannot double-count. Apps whose tools happen to be invoked inside a run are evidence in that run's trace, but they are not additional owners.
- Ownership is resolved from the live agent catalog. If the agent is missing from the catalog because its app was removed, the session remains inspectable under **Uninstalled App**. Rome does not persist a second owner snapshot.

**Not to be confused with:**

- **Apps invoked in a run** — an app whose action ran inside a turn appears in the trace but is not the owner. Only the agent's owning app is.

## Detached subagent sessions

A detached subagent session is a child session started by a caller that does not wait for it. The caller gets the child's session and turn ids and its own turn ends, while the child keeps running. This is how an agent on a schedule hands a long job to another agent without holding its own run open for it.

**Contracts:**

- A detached child belongs to an agent, not to the session that started it. Any later session of that same agent may read its status, give it another prompt, and stop it. Every other caller reads the child as absent, so a caller cannot learn that another agent's child exists.
- A resume keeps the child's original parent. The session that resumes a child does not become its parent, and the lineage the first run recorded stays put.
- The child outlives the caller's session but not the process. A detached child is not recovered after a restart, and a turn that was running when the process exited reads back as interrupted.
- The caller chooses the directory the child works in. It defaults to the caller's project directory, and a resume keeps the directory the child already works in.
- Rome caps how many detached children run at once, per calling session and across the process. Past a cap, starting another is refused rather than queued.
- Stopping a detached child is a request, like [Stop](#agent-run) on any other run. The child ends shortly afterwards and reports as interrupted, keeping the reply and trace it had produced.

**Not to be confused with:**

- **Subagent session** — an ordinary subagent blocks the turn that summoned it and reports back into that turn. A detached child reports to nobody until someone reads it.
- **[Forked turn](#forked-turns)** — a fork branches from a session's context. A detached child starts its own conversation.

## Forked turns

A forked turn is a side conversation branched from a live session's full context: the fork sees everything the source conversation has seen, but nothing it does can mutate the source.

The caller creating the fork chooses one of two modes:

- **Isolated** (the default) — the fork opens with an empty tool surface: no actions, skills, subagents, or builtin tools. It can only read the inherited conversation and answer. This is the right mode for side-channel turns that must not act.
- **Exact** — the fork opens with the source session's exact configuration, so the conversation prefix the model sees (system prompt, tool catalog, transcript) is identical to the source. Tools remain callable. Anything the fork executes is attributed to the fork's own session and turn — never the source's — and subagent output streams into the fork, not the source conversation. This is the mode for branch-style features that need the fork to behave as a true continuation of the conversation.

The caller also chooses how long the fork's provider branch lives:

- **One-shot** (the default) — the provider branch is disposable. It closes when the single turn completes, and nothing can resume it. Recap and turn-feedback forks run this way.
- **Continuable** — the caller asks for a provider thread of its own and Rome pins an agent session to it when the turn completes. Later turns resume that thread, so the fork becomes a conversation the guardian can keep talking to. A side chat runs this way.

**Contracts:**

- In both modes the source conversation is untouched: its next turn never sees the fork's prompt, output, or tool calls.
- The fork's model is the caller's choice in both modes: it follows the source's live model unless the caller overrides the tier. Exact-mode callers that want provider prompt-cache reuse keep the source's model. A fork never writes a [model pin](#model-pin) onto its source. A continuable fork records provider and model on its own agent session, which is what a later turn resumes from.
- A turn can be forked only after it completes successfully and Rome persists that exact turn's provider checkpoint. Running, stopped, failed, and checkpoint-less turns are not forkable. Rome never substitutes another turn's transcript head or reconstructs provider history from visible output.
- Every forked turn is recorded as its own fork session, linked back to the parent session and the turn the fork branched from, so its trajectory can be inspected like any other agent run.
- A fork is continuable only when it completed on a provider thread of its own. A branch whose turn errored, and one whose provider ran it inside the source thread, stay one-shot and read-only.
- A fork holds no scheduled wake-ups and hosts no approval continuation, continuable or not. Both resume through the top-level session host, which answers into the conversation that scheduled them.

**Not to be confused with:**

- **Subagent session** — a subagent is delegated work that reports back to its parent. A fork is a side conversation whose output never reaches the source session's next turn.
- **New session** — a new session starts from a blank slate. A fork inherits the source's full context.
