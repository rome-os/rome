# Actions

An action is the primary unit of executable behavior: app-owned code that reads state, writes state, and calls out to the world. Where a [skill](skills.md) teaches an [agent](agents.md) *how* to do something, an action is the thing that actually runs.

**Contracts:**

- Actions are owned by [apps](apps.md#rome-apps) and exist only via manifest declaration — no implicit discovery. Disabling an app removes its actions. Enabling it puts them back. Install re-reads the manifest, so a newly added action becomes callable without a process restart. Core's own actions, such as its [agent tools](#core-agent-tools), are the exception: core registers them at start.
- An action definition declares a [local artifact name](apps.md#artifact-names-and-references). The name cannot contain `:`. References and runtime calls use the canonical `<app-id>:<local-name>` id.
- An input schema makes an action agent-callable. A public action enters an agent catalog through `actions: ["*"]` or an exact reference. An explicit action enters only through an exact reference.
- An action without an input schema stays outside every agent catalog. It runs only when a [routine](data.md#routines) fires, a [hook](apps.md#hooks) routes to it, or another action calls it.
- Visibility gates both agent discovery and agent execution. It does not restrict routines, hooks, app APIs, or calls from another action.
- An approval-gated action never executes before the guardian's decision ([approvals](messaging.md#approvals)).
- A nested action call shares its caller's root and cancellation lifetime, and the caller must wait for its result. Fire-and-forget of a nested call is invalid: the caller may finish and release its resources while the callee is still running.
- Intentionally independent work starts **detached**: it becomes a new root execution with no parent. Cancelling the caller does not cancel it, and it can be cancelled separately by its own execution id.
- A detached start returns only an acceptance receipt, never the eventual result. Acceptance is not durable across a restart.
- Cancelling a root execution cancels everything under it.
- A few first-party coordination actions run in the main process when called as a root, instead of in an action worker, including `send_message`, `send_user_message`, `create_routine`, `send_feedback` and `publish_event`. They start no agent and may not call or dispatch other actions, so they never draw on the worker budget and never fail for want of a worker. They cannot be cancelled. Trust comes from the app's first-party install record, never from its manifest.
- An execution does not outlive the Rome process that runs it. Every execution still running when Rome stops is recorded as an error at the next start. An execution awaiting approval keeps waiting.
- An agent turn whose events an action reads runs only as long as the action's worker. When the worker goes away, whether it crashes, exits, or is cancelled, every such turn that has not ended stops with status `interrupted`. A turn whose reply main delivers to a channel keeps running.
- An action reaches Rome's accounts through `deps.channelsService`, naming each by its platform and the platform's own id, or a channel by its name. It sends and reads what was said the same way in the main process and in a worker, and never names a Connection ([channels for app actions](../architecture/channels.md#channels-for-app-actions)). An action never reaches a Connection's Talk, which is internal to core. Through the 0.7 release, reading `deps.talkRouter` throws an error that points to `deps.channelsService`.

**Not to be confused with:**

- **[Skill](skills.md)** — a skill is loaded into an agent's context as instructions. An action executes code.
- **Builtin tool** — the agent runtime provides builtin tools (file read/write, bash, web search). Actions are app-owned and manifest-declared.
- **[Hook](apps.md#hooks)** — a hook is an event subscription that routes into an action. The action is what runs.

## Core agent tools

A core agent tool is an action core declares so an agent can do what a dashboard page does, in chat. Core registers it in the main process under its full name, such as `system:pause_routine`. Unlike an app action, it has no manifest entry and never runs in an action worker.

**Rules:**

- Declare the tool in the `agent-tools.ts` file of the context that owns its operation, beside that operation, with the page's `agentTool` from [`agentToolsOf`](../../packages/core/src/apps/actions/agent-tool.ts). Add it to the page's list in the same file. A context that may not import `apps/`, such as the agent context, keeps its operation, and the page's tools live in `api/agent-tools/<page>.ts`, beside the page's routes.
- Give it a name, a description, `sideEffects`, `input`, and `run`. Add `approval` when the guardian approves a call on a card first. `approval` returns the card's words, or nothing for an input that runs without approval, such as every change but a removal. A call whose `approval` throws does not run.
- Write the arguments once, as the Zod `input`, each with a `.describe()` the agent reads. `run` and `approval` get their argument types from it. An input that does not fit answers the agent with what is wrong.
- Set `sideEffects` to `read-only` or `write`. It decides who may ask, in one check before `approval` and `run` ([`who-may-ask.ts`](../../packages/core/src/apps/actions/who-may-ask.ts)), so a turn that may not ask gets its refusal and no approval card. A read needs a turn that works for the guardian. A write needs the guardian's own message in their private chat. A tool holds no check of its own.
- Return plain data from `run` for the agent to read, `toolError(message)` for something not found or turned down, or `card(...)` for one of core's own cards, whose entry in `BUILTIN_CARDS` (`api/routes/webchat.ts`) names the tool. Say in an error what the agent does next.
- Reach other code only through the page's deps, which the wiring hands each page once ([`wiring/agent-tools.ts`](../../packages/core/src/wiring/agent-tools.ts)). A new page joins `PAGES` there, and its deps join the `registerAgentTools` call in `index.ts`.
- Enroll each tool in `whoMayAskSuite` in the page's test file. Test the operation through `callTool`, as the guardian.
- Never rename a tool. Agents, agent prompts and saved routines call it by its name.
- When a tool takes over from an older action or tool, list the older name in `olderNames`. While the agent may call the new tool, the catalog lists and searches only the new tool. A call by the older name still runs: as the older action while it is registered, else as the new tool.

**Example:**

```ts
const agentTool = agentToolsOf<ConnectionToolDeps>();

export const disconnectService = agentTool({
  name: "system:disconnect_service",
  description: "Disconnect one service from Rome, such as a Slack workspace. …",
  sideEffects: "write",
  input: z.object({ connectionId: z.string().describe("The connection's id, from read_connections.") }),
  approval: async ({ connectionId }, { deps }) => ({ title: "Disconnect …", summary: "…" }),
  run: async ({ connectionId }, { deps }) => {
    const outcome = await disconnectConnection(deps.registry, connectionId);
    if (outcome.status === "not-found") return toolError(`No connection found with id "${connectionId}". …`);
    return { connectionId, disconnected: true };
  },
});

export const connectionTools = [readConnections, connectService, disconnectService];
```

## Action results

Every action reports its outcome through one result envelope carrying exactly one status. The same envelope crosses every invocation boundary: agent tool results, app-to-app calls, and webhook invocation records.

**Contracts:**

- A result is exactly one of ok, error, pending approval, pending interaction, or widget placement — a single status, never a combination of flags.
- An action that wraps an external call collapses the provider's own success flag into the status. A failure never travels as an ok result carrying a failure payload.
- The error status is a domain rejection the caller can act on. An infrastructure failure — a crashed handler, a dead worker — surfaces as a thrown invocation error, never as a result.
- Pending approval parks the calling agent on the guardian's [approval](messaging.md#approvals). Pending interaction parks it on a [suspension](#suspensions). A widget placement completes on the same turn without parking anything.

**Not to be confused with:**

- **Invocation error** — the failure to run the action at all, thrown to the caller. A result, including the error status, is an outcome the action itself produced.

## Suspensions

A suspension is an action result that parks the calling agent until the guardian resolves it in webchat. It is an **inline interaction**: a component owned by the app, mounted inside the caller's own chat.

**Contracts:**

- The parked caller is told to wait and receives no artifact. The resolution arrives as a new turn carrying the outcome, and the action body does not run again.
- Every resolution is either the produced artifact or a dismissal. A dismissal is a first-class outcome the caller acknowledges and continues from, not an error.
- The artifact schema belongs to the owning app. Rome carries the artifact to the caller without interpreting it, so a new suspending action ships without a platform change.
- An inline interaction does not lock the chat, and several can be open at once.
- Only webchat renders suspensions. On a messaging channel, inside a subagent, or on a forked turn, the calling agent relays the prompt text as prose and the guardian's reply arrives as the next turn.

**Not to be confused with:**

- **[Approval](messaging.md#approvals)** — an approval parks an action before it executes, and the guardian authorizes it. A suspension is returned by an action that already ran, and the guardian produces its result.
- **Widget placement** — mounts an app widget on the workspace as a side effect of a completed result. Nothing is parked and nothing resolves.
- **Subagent** — delegated work that runs without the guardian and reports back to its parent turn.

## Actor

The actor is the authenticated session identity accountable for an action execution. Every recorded execution carries one, so "who did what" is answerable from the execution log alone.

**Contracts:**

- The actor is the [guardian](people.md#guardian), a [visitor](people.md#visitor), or anonymous. Anonymous means the chain entered a session-capable surface (the API surface, the app WebSocket server) with no session. An absent actor means no accountable session could exist anywhere in the chain — agent-autonomous work, routines, startup, and machine-credential surfaces such as webhooks.
- Capture is ambient, not per-route. Identity is established once where a request enters and flows to every action run during it, so a newly added route is attributed without doing anything.
- The whole execution chain inherits the root's actor — sub-actions, detached runs, and worker-process hops — no matter how many apps or agents sit in between.
- The trust boundary resolves the actor from primary session material, never from forwarded headers or app-supplied input ([access control](../architecture/access-control.md)).
- An automated dashboard message keeps its accountable actor separate from its source. With a guardian chain actor, the main agent, Concierge, and apps speak for the guardian: their messages use the guardian's avatar and viewer-relative side, with the source named below the bubble.
- Other sources, absent or anonymous chain actors, and visitor chains speak for themselves on the left with an Automated label. Each automated turn tells the receiving agent the guardian did not type it. Permissions and approvals stay unchanged.
- A live private Concierge turn may send one attributed input to a task owned by the same person and started in that Concierge chat. The host captures the source at tool-handler entry, before asynchronous setup, and binds the handoff to that turn, target chat, and exact input. It expires after 30 seconds and is consumed once. Stop, closure, a changed actor, chat or audience, or an archived chat refuse admission. A visitor stays a visitor. Group, unknown, forked, and autonomous sources grant no actor.
- The task message keeps Concierge as its source. Its admitted turn carries the verified actor through the usual action chain, without inheriting an approval. Model arguments, message text, and HTTP fields cannot grant an actor. Stopping the source before admission revokes its handoff. A follow-up from the same person in the same private chat, with the same audience, may supersede the source without revoking a pending handoff. It retains the captured actor, expiry and single-use limit. Any intervening identity or scope change revokes it permanently, even if a later input restores the original context. A callback with no eligible actor stays an ordinary automated send and never acquires an actor from a later turn. A refused handoff returns a delivery error even when its input was recorded. It does not run as unattributed work. The source actor stays unchanged for other tools. After admission the task has its own cancellation lifetime. Its [audience](../domains/participation.md#audience) is never more private than the source turn.
- A guardian handoff requires a private source audience. A shared guardian source grants no actor through this path.
- A guardian actor records the guardian seat, plus the bound cloud account id and email when known. A password-only seat has no email to record.
- Session-lifecycle audit telemetry stamps the same actor with the same absent-versus-anonymous semantics, so lifecycle changes are attributable from exported telemetry alone.

**Not to be confused with:**

- **Initiator** — the initiator names the triggering mechanism (an app, an agent, a routine). The actor names the accountable session. Both are recorded, and they are never interchangeable.
- **[Caller identity](apps.md#caller-identity)** — the caller is what one app observes for the request it handles. The actor is stamped on every execution in the chain, including hops no app observes.
