# Actions

An action is the primary unit of executable behavior: app-owned code that reads state, writes state, and calls out to the world. Where a [skill](skills.md) teaches an [agent](agents.md) *how* to do something, an action is the thing that actually runs.

**Contracts:**

- Actions are owned by [apps](apps.md#rome-apps) and exist only via manifest declaration — no implicit discovery. Disabling an app removes its actions. Enabling it puts them back. Install re-reads the manifest, so a newly added action becomes callable without a process restart.
- An action definition declares a [local artifact name](apps.md#artifact-names-and-references). The name cannot contain `:`. References and runtime calls use the canonical `<app-id>:<local-name>` id.
- An input schema makes an action agent-callable. A public action enters an agent catalog through `actions: ["*"]` or an exact reference. An explicit action enters only through an exact reference.
- An action without an input schema stays outside every agent catalog. It runs only when a [routine](data.md#routines) fires, a [hook](apps.md#hooks) routes to it, or another action calls it.
- Visibility gates both agent discovery and agent execution. It does not restrict routines, hooks, app APIs, or calls from another action.
- An approval-gated action never executes before the guardian's decision ([approvals](messaging.md#approvals)).
- A nested action call shares its caller's root and cancellation lifetime, and the caller must wait for its result. Fire-and-forget of a nested call is invalid: the caller may finish and release its resources while the callee is still running.
- Intentionally independent work starts **detached**: it becomes a new root execution with no parent. Cancelling the caller does not cancel it, and it can be cancelled separately by its own execution id.
- A detached start returns only an acceptance receipt, never the eventual result. Acceptance is not durable across a restart.
- Cancelling a root execution cancels everything under it.

**Not to be confused with:**

- **[Skill](skills.md)** — a skill is loaded into an agent's context as instructions. An action executes code.
- **Builtin tool** — the agent runtime provides builtin tools (file read/write, bash, web search). Actions are app-owned and manifest-declared.
- **[Hook](apps.md#hooks)** — a hook is an event subscription that routes into an action. The action is what runs.

## Action results

Every action reports its outcome through one result envelope carrying exactly one status. The same envelope crosses every invocation boundary: agent tool results, app-to-app calls, and webhook invocation records.

**Contracts:**

- A result is exactly one of ok, error, pending approval, pending interaction, handoff, or widget placement — a single status, never a combination of flags.
- An action that wraps an external call collapses the provider's own success flag into the status. A failure never travels as an ok result carrying a failure payload.
- The error status is a domain rejection the caller can act on. An infrastructure failure — a crashed handler, a dead worker — surfaces as a thrown invocation error, never as a result.
- Pending approval parks the calling agent on the guardian's [approval](messaging.md#approvals). Pending interaction and handoff park it on a [suspension](#suspensions). A widget placement completes on the same turn without parking anything.

**Not to be confused with:**

- **Invocation error** — the failure to run the action at all, thrown to the caller. A result, including the error status, is an outcome the action itself produced.

## Suspensions

A suspension is an action result that parks the calling agent until the guardian resolves it in webchat. Two kinds exist: an **inline interaction** mounts a component owned by the app inside the caller's own conversation, and a **handoff** transfers the floor to a child session where the guardian collaborates with a summoned agent.

**Contracts:**

- The parked caller is told to wait and receives no artifact. The resolution arrives as a new turn carrying the outcome, and the action body does not run again.
- Every resolution is either the produced artifact or a dismissal. A dismissal is a first-class outcome the caller acknowledges and continues from, not an error.
- The artifact schema belongs to the owning app. Rome carries the artifact to the caller without interpreting it, so a new suspending action ships without a platform change.
- An inline interaction does not lock the conversation, and several can be open at once. A handoff locks the parent conversation until control returns.
- A handoff's child session is bound to the summoned agent for its whole life. It never appears in the chat sidebar — the guardian reaches it through the card in the parent conversation.
- A handoff that declares a handback contract hands control back only through it: the candidate artifact must satisfy the contract, and the guardian approves the candidate before it resumes the caller. A validation failure bounces to the summoned agent, never to the caller.
- Only webchat renders suspensions. On a messaging channel, inside a subagent, or on a forked turn, the calling agent relays the prompt text as prose and the guardian's reply arrives as the next turn.

**Not to be confused with:**

- **[Approval](messaging.md#approvals)** — an approval parks an action before it executes, and the guardian authorizes it. A suspension is returned by an action that already ran, and the guardian produces its result.
- **Widget placement** — mounts an app widget on the workspace as a side effect of a completed result. Nothing is parked and nothing resolves.
- **Subagent** — delegated work that runs without the guardian and reports back to its parent turn. A handoff summons an agent specifically to work with the guardian.

## Actor

The actor is the authenticated session identity accountable for an action execution. Every recorded execution carries one, so "who did what" is answerable from the execution log alone.

**Contracts:**

- The actor is the [guardian](people.md#guardian), a [visitor](people.md#visitor), or anonymous. Anonymous means the chain entered a session-capable surface (the API surface, the app WebSocket server) with no session. An absent actor means no accountable session could exist anywhere in the chain — agent-autonomous work, routines, startup, and machine-credential surfaces such as webhooks.
- Capture is ambient, not per-route. Identity is established once where a request enters and flows to every action run during it, so a newly added route is attributed without doing anything.
- The whole execution chain inherits the root's actor — sub-actions, detached runs, and worker-process hops — no matter how many apps or agents sit in between.
- The trust boundary resolves the actor from primary session material, never from forwarded headers or app-supplied input ([access control](../architecture/access-control.md)).
- A guardian actor records the guardian seat, plus the bound cloud account id and email when known. A password-only seat has no email to record.
- Session-lifecycle audit telemetry stamps the same actor with the same absent-versus-anonymous semantics, so lifecycle changes are attributable from exported telemetry alone.

**Not to be confused with:**

- **Initiator** — the initiator names the triggering mechanism (an app, an agent, a routine). The actor names the accountable session. Both are recorded, and they are never interchangeable.
- **[Caller identity](apps.md#caller-identity)** — the caller is what one app observes for the request it handles. The actor is stamped on every execution in the chain, including hops no app observes.
