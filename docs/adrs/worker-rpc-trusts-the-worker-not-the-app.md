# Worker RPC trusts the worker, not the app calling through it

- **Status**: Accepted
- **Date**: 2026-10-09
- **Concept**: [actions](../concepts/actions.md)

## Context

An action that runs in a worker reaches the main process over the worker RPC ([`actions/worker-rpc.ts`](../../packages/core/src/actions/worker-rpc.ts)). Some of its methods serve the system app alone: `agentNames.resolve` lists the guardian's agents and linked accounts' agents with their ids, `feedback.send` carries reporter provenance, and the `apps.*` lifecycle methods install and remove apps. Each is gated where it is handed out. Core passes the service only to actions whose owner is `system`, and the system action checks its caller before it runs, such as `send_message` sending by name only for the `main` agent.

The RPC itself does not know which app sent a request. Workers are pooled and run whichever app's action the engine hands them, so a worker is not bound to one app. App code in a worker shares the process with the SDK that sends the request, so it can send any method directly, skipping both gates.

Closing the gap at the RPC means the main process attributes each request to an app it trusts. A tag the worker adds to its own request is no proof, since app code in the same process can write any tag. Real attribution needs a worker bound to one app for its life, with the binding kept in the main process, which ends the shared pool.

## Decision

The worker RPC trusts any request from an attached worker. A system-only method is gated where its service is handed out and inside the system action that uses it, not at the RPC boundary. The gap this leaves is accepted while cross-account agent links are in development.

## Alternatives

- **Tag each request with the calling app and refuse system-only methods from any other app.** Rejected because the tag comes from the same process as the app code it would guard against, so that code can forge it. It would read as a check without being one.
- **Bind each worker to one app and attribute requests in the main process.** Rejected for now because it ends the shared warm pool, so every app pays a cold worker start, and it changes the protocol every RPC method uses. It is the fix to reach for once an app's reach into the guardian's data has to be enforced, not only conventional.
- **Keep system-only services off the worker RPC, and run the actions that use them only in the main process.** Rejected because the engine, not the action, decides where an action runs, and an action marked cancellable runs in a worker ([IPC semantics on every action invocation](ipc-semantics-on-every-action-invocation.md)). Pinning system actions to the main process would make that decision depend on who owns the action.

## Consequences

System-only services stay one injected dep and one RPC method each, with no per-app bookkeeping, and the warm pool stays shared. An installed app can still read what a system-only method returns, or call a lifecycle method, by sending the request from its worker code. The guardian's agent listing and app installs are therefore reachable from any installed app that sets out to reach them.

Future diffs must respect:

- A new system-only RPC method is gated where its service is handed out and in the action that uses it, the same way `agentNames` and `feedback` are, and [channels.md](../architecture/channels.md#channels-for-app-actions) or the service's own doc names this gap.
- Nothing describes a system-only method as enforced against installed apps while this record stands.
- Binding workers to one app supersedes this record. The change that binds them also moves the system-only checks to the RPC boundary.
