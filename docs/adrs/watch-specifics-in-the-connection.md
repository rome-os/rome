# What a service can watch, and what its events mean, belongs to its connection

- **Status**: Accepted
- **Date**: 2026-11-04
- **Architecture**: [Concierge following](../architecture/concierge-following.md)

## Context

The Concierge follows things for the guardian: a repository's pull requests and CI, new mail in an inbox. Each service differs in every step. GitHub pushes a webhook per repository and needs admin rights to create it. Gmail arrives through a Composio trigger that polls, and Composio wants its own account id and label format. The raw payloads share nothing: a GitHub delivery names a login and an action, and a Gmail message carries headers, labels and a category tab.

The first version put those differences in the follower. The Concierge listed GitHub event types, read GitHub payloads, and filtered mail by header. A second follower would repeat that work, and the guardian would meet two names for one event and two answers to "can Rome watch this?". The guardian also wants the Concierge to show a Connectors page later, with one list of services and what each can do. That list needs one owner for "what can be watched here, and is it working".

The connector app already holds every credential, every subscription and the relay webhook. It is the only place that can tell a missing connection from a missing relay or missing admin rights.

## Decision

Every service difference lives in the connection. The connector app declares a watch provider with four actions: it lists what can be watched and whether it works, subscribes, normalizes a raw event into one common shape with generic fields (`byYou`, `addressedTo`) and labels of its own choosing, and releases a subscription. Core finds the provider from the app's declaration and never names a service or the app.

## Alternatives

- **Each follower reads each service itself.** Rejected because every new follower repeats the event names, payload parsing and status checks, and the guardian sees them drift apart.
- **Core keeps a per-service adapter next to following.** Rejected because adding a service would then change core as well as the connection, and core would hold service knowledge it cannot test without the service's credentials.
- **Normalize at ingest, before the event bus.** Rejected because the bus serves other consumers that read the raw payload, such as Code Review and `defer`. Normalizing also needs the follow's account and kinds, which ingest does not know.
- **Name the connector app in core.** Rejected because a second app that can watch a service would then need a core change, and core could not tell a provider from any other app.

## Consequences

A new service changes its connection only: one adapter with its catalog entry, its account, its subscription and its normalizer, listed once in the connection's registry. The connection's own watch actions and shared code dispatch through the registry and name no service either. Following, triage and delivery stay unchanged.

The common shape has to carry enough for triage to judge an event without the raw payload. When a service needs a new fact, the fact is added to the shape as a plain value, never as a service field that core reads.

Future diffs must respect:

- No branch on a service name outside the connection, in following, triage, delivery or a client.
- A watch provider names only its own app's actions.
- The event bus keeps the raw event. A follower normalizes through the provider when it handles the event.
