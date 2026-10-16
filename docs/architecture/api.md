# API Surface

How traffic reaches the Rome backend: every external caller arrives over one HTTP listener, and every [action](../concepts/actions.md) worker calls main over one fork IPC channel. This doc owns the constraints that keep those two transports apart, and the delegation rules on the worker channel. [`access-control.md`](access-control.md) owns who an HTTP caller is and what it may reach. The cross-service protocol contracts with [Rome Cloud](../concepts/rome-cloud.md) — [instance sign-in](../concepts/rome-cloud.md#instance-sign-in) and the [OAuth handoff](../concepts/rome-cloud.md#oauth-handoff) — live on the concept.

```
external caller ──HTTPS──► edge ──verify + proxy──► backend (one route set)
action worker ──fork IPC──► main ──spawn──► delegated worker
```

## HTTP surface

A single server hosts every HTTP route behind the [edge](access-control.md#request-flow). Four categories share the listener: the dashboard API with its websockets, the access-gated [app surfaces](access-control.md#policies), the [public allow-list](access-control.md#request-flow), and the webhook ingress. [`access-control.md`](access-control.md) owns the per-category auth and the fail-closed default. The callers are concepts entries — [guardian](../concepts/people.md#guardian) and [visitor](../concepts/people.md#visitor).

### Invariants

- One listener serves the whole HTTP surface. The edge and the direct backend origin expose the same route set — a second listener does not exist, and a route hidden from the edge does not exist.
- Worker-to-main traffic never rides HTTP. A service a worker needs joins the [Worker RPC](#worker-rpc) surface, never a route.

## Worker RPC

The main process creates every worker that runs a cancellable [action](../concepts/actions.md) out of process, and it holds a direct fork IPC channel to each one. A worker never forks a worker. A worker that needs a nested subprocess action delegates it to main. A worker that starts intentionally independent work asks main to dispatch a new root. Either way main spawns the target worker on a channel of its own. The operating-system process tree stays flat while execution ids carry the logical action tree ([decision](../adrs/workers-never-fork-workers.md)). What a caller observes — the nested cancellation lifetime, the detached acceptance receipt, the root-cancel cascade — is an [action contract](../concepts/actions.md).

### Invariants

- Only main creates workers, and no worker relays a call for another ([decision](../adrs/workers-never-fork-workers.md)).
- A pending RPC never outlives its peer: timeout, disconnect, or worker exit rejects it.
- A handler runs under the caller's trace context, carried on the request, or under no span when the request carries none. It never inherits the context that was active when main forked the worker, because a pooled worker serves unrelated roots.
- Delegated action execution has no duration deadline. It ends on result, root cancellation, owner-worker disconnect, child exit, or main shutdown — never on elapsed time.
- Cancelling a root follows the logical action tree, not the process tree: every worker running under that root terminates, including workers main spawned on another worker's behalf.
- The transport is core-internal. The app-facing runtime names no IPC primitive, and an app-level invocation behaves identically in main and in a worker — every invocation carries [fork IPC semantics](../adrs/ipc-semantics-on-every-action-invocation.md) in both processes.
