# Only the main process creates action workers

- **Status**: Accepted
- **Date**: 2026-08-11
- **Architecture**: [API surface — Worker RPC](../architecture/api.md#worker-rpc)

## Context

An [action](../concepts/actions.md) marked cancellable runs in its own worker process, and any action can call another one. A worker executing an app action can therefore reach a call that needs a second process, at any depth. A worker can also start an action that outlives the call frame it runs in, which is a new root rather than a nested call.

Main holds the services a worker calls back into: agent sessions, events, channels, and app lifecycle. Main attaches those services to a worker at creation time, over the single IPC channel it has to that worker. A worker holds none of them, because a worker is a callee of the control plane rather than a member of it.

That pairing decides the topology. A process forked by a worker has exactly one IPC peer, and that peer is the forking worker. Every main-owned service is then unreachable from the grandchild, and the gap gives no signal at author time: the call reaches a peer with no handler for it and the caller waits out the method deadline. The set of main-owned services also grows over time, so the gap widens with each service added.

A worker runs arbitrary third-party app code, which bounds what it can be asked to guarantee. Any routing duty placed on a worker has to hold while that worker is busy executing an app handler, and has to survive that handler crashing or the worker exiting.

Nesting still has to be visible to the runtime whatever the process shape. Approvals, the replay journal, cancellation fan-out, and the persisted execution rows all depend on knowing which execution parented which. The operating-system parent-child edge is one way to carry that, and it comes with a termination cascade attached.

## Decision

Only the main process creates an action worker. A worker that needs a nested action in a subprocess asks main to execute that action, and the logical action tree travels as execution identity — `rootExecutionId` and `parentExecutionId` — rather than as an operating-system parent-child edge.

## Alternatives

- **Fork the nested worker from the worker that needs it, the industry default.** Rejected because the forked child inherits an IPC connection to a peer that holds no main-owned service. An agent turn started from that child reaches a process with no handler for it, and the failure appears only as an expired deadline in an unrelated call.
- **Relay the agent-session methods through the intermediate worker.** Rejected because it repairs one named surface and leaves the next one exposed. Every main-owned service added later would depend on someone remembering to add a matching relay, and forgetting one reproduces the same silent deadline.
- **Relay every main RPC generically through the intermediate worker.** Rejected because it makes a process running third-party app code a required router for the control plane. Correct routing and disconnect handling would then have to be duplicated in every worker and hold while that worker executes an app handler.
- **Hand the worker a worker handle from main and let it drive the child.** Rejected because a handle returns process lifecycle to the worker, so main cannot guarantee that services are attached or that the child dies when its owner does. Ownership of a process is the thing that has to stay in one place.
- **Run nested cancellable actions inside the calling worker.** Rejected because it drops the process isolation and the process-level termination that `cancellable` exists to request. That changes the action contract to remove a topology problem.
- **Let main serve the nested delegation by re-entering its own action dispatch.** Rejected because it gives main a second opinion about root and nested identity, approval, and replay, competing with the worker that already owns the call frame. Process delegation has to stay below logical action dispatch, so main executes an already-approved payload at the process layer only.

## Consequences

One control plane covers every worker at every depth. A new main-owned service becomes reachable from any worker by registering one handler on main, with no relay to write and no depth to consider. Every worker looks identical to main — one IPC channel and one attach step — so the flat process tree also reads directly in `ps` and in logs, where each worker's parent is main.

Main pays for the parent-child edge it gives up. Ownership becomes explicit bookkeeping that main maintains: which worker delegated which, which workers belong to a root execution, and which execution a worker serves. Cancellation fan-out and owner-disconnect cleanup are code rather than an operating-system side effect, and a leak in that bookkeeping strands processes. A result arriving after its owner disconnects has to be discarded rather than applied.

Every action worker draws on one budget held by main. Root workers, pooled workers, and delegated workers are the same resource under one owner, so a cap on live worker processes covers all of them at once. Reaching that cap fails the call immediately rather than queueing it, because a nested call that waits for capacity holds every ancestor worker open and a chain of nested calls can then deadlock.

Every worker-to-main callback is an ingress boundary. It runs outside the ambient replay and execution contexts, so logical identity has to come from the serialized request. A pooled worker's creation-time async context can never decide whether a later action is root or nested.

Future diffs must respect:

- No path outside main's process layer creates an action worker. Worker-side engines receive no fork factory, so the worker path holds no import of `child_process.fork`.
- Nesting travels as data. A new execution path carries root and parent execution ids instead of reading process parentage, and persisted rows keep that identity across the flat tree.
- Main handles a new worker-callable service on the connection it holds to that worker, and the service joins the [Worker RPC surface](../architecture/api.md#worker-rpc). No intermediate worker relays it.
- Nested delegation stays a process-layer command. Main runs the already-approved payload and does not re-dispatch it through its own action dispatch, which would create a second logical root. The one request that does enter main's action dispatch is the explicit detached one, because its contract is a new root. Main accepts that request only when the payload names no parent and its execution id equals its root execution id.
- Per-worker state keys off execution identity, not process parentage. Main hands the same pooled worker to a root action and to a delegated nested call, so a reused worker carries nothing from an earlier root.

## Amendment (2026-10-07): a root whose caller holds no worker queues

The decision above failed every call at the worker cap, and it stands for nested calls and for any root whose caller may hold a worker. A root run that opts into `whenWorkersBusy: "queue"` waits instead. It waits in arrival order for a slot, and it fails with the same capacity error once a ten-minute deadline passes.

Three callers opt in, because no worker waits on any of them. A routine fire starts from the routine engine in main. An app API request from outside the instance (an external webhook, a relay replay, a browser session) gets an app context whose `runAction` queues. A detached dispatch counts as accepted once it joins the queue, so a worker that dispatches never waits on capacity.

Every other caller stays fail-fast. An agent session lives in main, but the `summon` or `send_message` that drives its turn usually holds a worker, so a queued tool call could wait on the slot its own ancestor occupies. The same holds for app code that runs during such a turn, such as turn middleware, and for a loopback API request, which can come from the agent itself. A missing execution store does not prove independence, because main clears that store at every worker ingress, so the opt-in is set where the caller is known rather than inferred from ambient context.

Queued roots never take the last two slots. Those stay with fail-fast callers, so a backlog of background roots cannot fail every agent tool call and interactive turn until it drains.

Alternatives rejected for this amendment:

- **Queue every root.** Rejected because an agent tool call is a root in main whose caller is a worker waiting on the turn, so a full pool of turn-holding workers would wait on each other until the deadline.
- **Retry at each caller.** Rejected because every scheduling boundary would reimplement the same backoff, and a caller that gives up drops work such as a routine fire with no second delivery.
- **Raise the cap.** Rejected because a burst of long agent roots fills any fixed cap, and the cap exists to bound memory on the smallest instance.

This amends the consequence that reaching the cap fails the call immediately. Future diffs must respect: a caller opts into queueing only when it holds no worker and no worker waits on it synchronously, and the queue never admits a root into a reserved slot.
