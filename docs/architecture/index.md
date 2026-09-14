# System Architecture

Architecture docs, organised by surface. Each doc names the components on a surface, the contracts between them, and the invariants that must hold. Vocabulary lives in [`../concepts/`](../concepts/index.md) — architecture docs link there for shared entity definitions.

Browse by surface:

- [`process.md`](process.md) — How a Rome process is bound to a host and a profile, and how state mutations are serialised.
- [`app-lifecycle.md`](app-lifecycle.md) — Which components own the install, uninstall, and boot state transitions, and the ordering rules that survive crashes and reloads.
- [`app-artifact.md`](app-artifact.md) — How a packed app artifact crosses from its builder to the installer, and the gates that hold on both sides of the handoff.
- [`api.md`](api.md) — The backend's two request transports: the single HTTP listener behind the edge, and the worker fork IPC channel with its delegation rules.
- [`suspensions.md`](suspensions.md) — How a parked action call, its card, and its resolution stay correlated across the chat seam, and the session split that keeps a handoff out of the parent thread.
- [`access-control.md`](access-control.md) — The app and dashboard access policies, the fail-closed edge probe, and the visitor sign-in flow.
- [`build.md`](build.md) — The generated runtime workspace and its closure boundary, the monorepo layout, and the first-party pre-pack step.
- [`channels.md`](channels.md) — The server-owned setup protocol every channel connects through, and the rules that keep the connect flow generic.
- [`notification-delivery.md`](notification-delivery.md) — How mobile push travels from an instance through the central Rome Cloud broker to the platform push service (APNs for iOS, FCM for Android), and the account-scoping, content-enforcement, and delivery invariants that hold.
- [`desktop-runtime.md`](desktop-runtime.md) — How the macOS desktop shell hosts the Rome backend in a Linux VM, and the network/signing invariants the provider must satisfy.
- [`host-execution.md`](host-execution.md) — How system actions delegate privileged jobs to a Linux host service and preserve its authorization boundary.
- [`observability.md`](observability.md) — The OTEL → Collector → ClickHouse pipeline, required telemetry attributes, and the dev-vs-prod topology split.
