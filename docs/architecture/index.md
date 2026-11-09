# System Architecture

Architecture docs, organised by surface. Each doc names the components on a surface, the contracts between them, and the invariants that must hold. Vocabulary lives in [`../concepts/`](../concepts/index.md) — architecture docs link there for shared entity definitions.

Browse by surface:

- [`process.md`](process.md) — How a Rome process is bound to a host and a profile, and how state mutations are serialised.
- [`app-lifecycle.md`](app-lifecycle.md) — Which components own the install, uninstall, and boot state transitions, and the ordering rules that survive crashes and reloads.
- [`app-artifact.md`](app-artifact.md) — How a packed app artifact crosses from its builder to the installer, and the gates that hold on both sides of the handoff.
- [`api.md`](api.md) — The backend's two request transports: the single HTTP listener behind the edge, and the worker fork IPC channel with its delegation rules.
- [`suspensions.md`](suspensions.md) — How a parked action call, its card, and its resolution stay correlated across the chat seam.
- [`access-control.md`](access-control.md) — The app and dashboard access policies, the fail-closed edge probe, and the visitor sign-in flow.
- [`build.md`](build.md) — The generated runtime workspace and its closure boundary, the monorepo layout, and the first-party pre-pack step.
- [`channels.md`](channels.md) — The server-owned setup protocol every channel connects through, and the rules that keep the connect flow generic.
- [`notification-delivery.md`](notification-delivery.md) — How mobile push travels from an instance through the central Rome Cloud broker to the platform push service (APNs for iOS, FCM for Android), and the account-scoping, content-enforcement, and delivery invariants that hold.
- [`named-desktops.md`](named-desktops.md) — The fixed table of X displays kept for one owner each, the script that starts them so they outlive Rome, and the loopback and guardian-only rules for viewing them.
- [`host-execution.md`](host-execution.md) — How system actions delegate privileged jobs to a Linux host service and preserve its authorization boundary.
- [`concierge.md`](concierge.md) — How one Concierge talks in its main and topic chats, hands work to task chats, and sends each result, alert and digest to the chat that should hear it.
- [`concierge-following.md`](concierge-following.md) — How an event from a followed service reaches the Concierge through its connection, triage and digest, and the rules that keep service differences in the connection.
- [`observability.md`](observability.md) — The OTEL → Collector → ClickHouse pipeline, required telemetry attributes, and the dev-vs-prod topology split.
