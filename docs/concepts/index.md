# Core Concepts

This is the concepts index — the single source of truth for entity definitions in Rome. Other documents link to specific entries here rather than re-explaining concepts. Before adding or renaming an entry, apply the entry format and admission bar in [concepts.md](../authoring/concepts.md).

Browse by domain:

- [`people.md`](people.md) — Guardian, Visitor, Persons, Accounts, Addresses, Links, Bond levels. *Who Rome serves and who it interacts with.*
- [`deployment.md`](deployment.md) — Profiles, Instances. *How a deployment names itself for data isolation and for telemetry.*
- [`rome-cloud.md`](rome-cloud.md) — Rome Cloud, Instance sign-in, OAuth handoff. *The operator-run service in front of all instances.*
- [`agents.md`](agents.md) — Agents (incl. the agent hierarchy). *The LLM-backed runtime entities.*
- [`sessions.md`](sessions.md) — Sessions, Model pin, Agent runs, Owning app, Forked turns. *The durable boundary around agent work.*
- [`messaging.md`](messaging.md) — Messages, Conversations, Channels, Policies, Sentinel, Approvals. *How messages flow in and how the system decides what to do with them.*
- [`apps.md`](apps.md) — Rome Apps (incl. ids, SDKs, caller identity, lockfile, install sources, app store, handles, app data, hooks). *The extensibility surface.*
- [`actions.md`](actions.md) — Actions, Action results, Suspensions, Actor. *The primary unit of executable behavior, its result envelope, and the session identity accountable for it.*
- [`skills.md`](skills.md) — Skills. *Instructional documents that teach agents how to perform tasks.*
- [`data.md`](data.md) — Memory, Projects, Routines, Database. *Where state and knowledge live.*

## Entry candidates

Terms used on multiple surfaces with no entry yet. Each needs a full pass through the [admission bar](../authoring/concepts.md#admission) before it becomes an entry. They are listed here so recurring confusion has a place to land. Format: term — surfaces — suspected contract.

- **Connection (+ grant, talk/act/watch capability)** — connections runtime, dashboard connection pages, [`architecture/channels.md`](../architecture/channels.md) — one service = one connection holding named revocable grants exposing up to three capabilities.
- **Setup (conferral setup)** — connection setup runtime, dashboard setup renderer, [`architecture/channels.md`](../architecture/channels.md) — a server-owned resumable connect protocol with a closed verb set. Any surface can render any setup.
- **Turn (agent turn)** — turn lifecycle hooks, trace surfaces, `sessions.md` prose, [`architecture/suspensions.md`](../architecture/suspensions.md) — the atomic unit of agent work: carries a turn id, a lifecycle hook pair, and is the granularity of model-pin and fork rules.
- **Trace** — per-turn evidence storage, dashboard trace drawer, replay app agent prompt — append-only per-turn evidence stream, distinct from OTEL spans, which docs never disambiguate.
- **Seat (guardian seat)** — guardian auth state, [`actions.md#actor`](actions.md#actor), [`architecture/access-control.md`](../architecture/access-control.md) — the single per-instance guardian record, stable across login methods. [`people.md#guardian`](people.md#guardian) covers the role, not the record.
- **Webchat** — webchat runtime, dashboard chat, agent prompts, several concepts entries use it undefined — the dashboard-native channel and the only interactive surface.
- **Webhook** — webhook API surface, [`architecture/api.md`](../architecture/api.md) — machine-credential, actor-less async action entry point.
- **Settings (instance KV vs conversation settings)** — settings APIs and UI, [`architecture/notification-delivery.md`](../architecture/notification-delivery.md) — two distinct things sharing one word. The ambiguity is the reason to document.
- **Notification** — notification transcript rows, [`architecture/notification-delivery.md`](../architecture/notification-delivery.md) — an out-of-band delivery to the guardian that is also a durable transcript row — not a channel message, not an approval.
- **Relay (instance mailbox)** — relay runtime, dashboard — Rome Cloud-side durable mailbox buffering inbound events for an offline instance, drained in order with acknowledgements.
- **Favor** — favors runtime, settings UI, [`apps.md#caller-identity`](apps.md#caller-identity) — Rome Cloud-minted currency gating a visitor-invoked action on another guardian's instance.
- **Envoy** — envoy agent config, agent runner, one line in [`agents.md`](agents.md#agent-hierarchy) — the outbound-validation gate for agent-authored external messages — arguably a gap in `agents.md` rather than a new entry.

## Related docs

- [`../../VISION.md`](../../VISION.md) — why Rome exists, posture, scope.
- [`../architecture/`](../architecture/index.md) — components, surfaces, and the invariants binding them.
- [`../../CLAUDE.md`](../../CLAUDE.md) — the repo map.

For doc-writing rules, see [`../CLAUDE.md`](../CLAUDE.md).
