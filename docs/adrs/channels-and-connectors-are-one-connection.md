# Channels and connectors are one Connection, gated by named grants

- **Status**: Accepted
- **Date**: 2026-08-11
- **Architecture**: [Channels](../architecture/channels.md)

## Context

Two vocabularies cover the same ground. A channel is a conversational surface with an adapter, an inbound message hook, and a reply path. A connector is a credentialed operation surface that actions invoke, with webhook ingestion bolted on beside it to trigger routines. The line between the two follows which subsystem a service was built in rather than what the service affords.

Real services cross that line. Slack is one service carrying a conversation surface, an operation surface, and an event stream, and a single OAuth dance authorizes all three. GitHub has operations and webhooks and no conversation, so the channel vocabulary excludes it, even though its inbound webhook is the same "the service pushes to Rome" affordance a channel's inbound stream is. Discord offers a bot token that drives conversation and a separate user OAuth that drives operations.

Authority does not arrive as one credential per service. The unit is the conferral — one act in which the guardian hands Rome authority the service thereafter accepts. Slack's one dance mints a bot token and a user token, which is one conferral holding two tokens. A service that confers bot authority and user authority in separate acts needs two grants. Webchat needs none at all. One conferral can serve several capabilities, and one capability can depend on several conferrals.

Partial availability is an ordinary state rather than a fault. A dead grant has to relock the capabilities that need it while the rest of the connection keeps running. Callers also need the reason a capability is unavailable before any credential exists: whether to confer a named grant, to create a subscription, or that the service can never do that at all. A boolean cannot carry any of those three answers.

The industry default keeps the two stacks apart and authorizes each on its own, and it gives an integration one credential plus a runtime `isConnected()` or an auth check at the call site. Rome shipped that default, with channel credentials in the settings table and connector credentials in provider accounts. One service is two records under it, wired through two subsystems, authorized twice, with two health stories. Connection setup pulls the other way: every channel connects through [one server-owned setup protocol](../architecture/channels.md#connection-setup), which needs one thing to address a setup at.

## Decision

Every external service Rome wires to is reached through one kind of thing, a Connection: a set of named grants, where one grant is one conferral, plus up to three capabilities — Talk, Act, and Watch — each declaring which grants it needs. A capability handle is non-null exactly when the integration implements that capability and every grant it needs is live. A Watch the service feeds only under a resource subscription also needs one active subscription.

A service carries at most one Connection. The original design chose the opposite — connections minted per connect, so two Slack workspaces would be two Connections — and that half was not carried into the implementation. The shipped registry refuses a second connect for a service it already holds, and a unique index on the service column enforces it in the database. This record covers the unification of channels and connectors, which shipped. The per-connect cardinality is a design that did not.

## Alternatives

- **Keep channels and connectors as separate subsystems, as the industry default does.** Rejected because the split is drawn on Rome's build history rather than on what a service affords, and services do not respect it. One service ends up authorized twice into two credential records that drift. Slack cannot spend its single OAuth dance on both its conversation and its operation surfaces, and GitHub sits outside the conversational vocabulary while needing the same inbound delivery a channel needs.
- **Unify the credential store and leave the two runtimes in place.** Rejected because the mismatch is in which affordances a service has, not only in where its token sits. Webhook ingest still hangs off the connector runtime as a separate thing, and a shared inbound stream that carries both chat messages and non-message events has to be received twice, once per subsystem.
- **Give a connection one credential, the way an integration usually carries one.** Rejected because authority arrives per conferral, not per service. One credential forces a service with two independent conferrals into an all-or-nothing connect, and it makes partial availability unrepresentable, so a dead operations credential would take conversation down with it.
- **Fix each capability to a designated credential — conversation on the channel credential, operations on the connector credential.** Rejected because real services break the pairing in both directions. Telegram's single bot token serves conversation and events together, GitHub's event delivery needs no grant at all because its verification material is Rome-minted, and every such service becomes a special case in framework code.
- **Keep one capability object per integration and answer availability with a runtime check, either `isConnected()` or a 401 from the attempt.** Rejected because the check becomes a discipline every call site has to remember, and the object outlives the authority it was built on. A revoked credential leaves a live handle that still looks callable, and the failure surfaces as a provider error deep inside an action instead of a locked capability at the edge.
- **Let a capability read its credential from the store at call time instead of receiving it at build time.** Rejected because a long-lived instance then runs against stale authority after a rotation or a revoke, and every integration has to re-implement its own reload. Rebuilding the capability per grant epoch puts that behavior in one place and makes the non-null invariant structural.
- **Expose availability as one connected boolean per connection.** Rejected because degradation is per grant and the guardian-facing answer has to name what to do. A boolean cannot say which grant is missing, cannot distinguish an unconfigured subscription from a missing conferral, and cannot express a connection whose conversation runs while its operations are locked.
- **Keep webhook ingestion as its own subsystem outside connections.** Rejected because unsolicited inbound delivery is the same affordance a conversational inbound stream is, and a separate subsystem re-authorizes and re-verifies a service the connection already holds authority for. Origin verification and delivery dedupe would then exist twice, with two chances to fail open.
- **Design connecting a service and using one as a single problem, so conferral flows and capability wiring share a contract.** Rejected because the two change on different clocks and would drag each other along. They agree on the grant ledger and two crossing signals, which is enough for either side to move, and widening that agreement puts guardian-facing interaction back inside the code that invokes operations.

## Consequences

One service reads as one thing. It carries at most one connection, with one connect surface, one credential ledger, one health story, and one set of capabilities the guardian can reason about. Adding an integration means naming its grants and declaring which of the three capabilities it implements and what each needs, with no subsystem to choose between. Partial availability becomes ordinary discovery rather than a special state, and a locked capability is unreachable because there is nothing to call.

The costs land on builders and on callers. The degenerate case — one credential, one capability — still pays the grant vocabulary. Capability instances are rebuilt whenever a grant they need changes state or credential, so an integration holds no state across epochs. A long-lived stream reports its faults through a fault channel, while a credential a service refuses mid-call reaches the caller and grant state at once. A caller wires per unlock epoch through the registry rather than holding a handle for the process lifetime. A conferral or a renewal rebuilds the capability, and only material the transport rotates on its own updates in place.

The one-connection-per-service rule is the other cost. A guardian who wants two accounts of one service cannot have them, and a second connect attempt is refused with the duplicates named for an operator to resolve. Person resolution keys on the service rather than on the connection.

Future diffs must respect:

- Every external service Rome wires to is reached through a Connection. A new conversational surface or a new credentialed API does not earn its own subsystem, and neither does webhook ingestion.
- A service holds at most one Connection, and the uniqueness sits in the database rather than in caller discipline. Widening that to several accounts of one service is its own decision, taken against the registry and the index, not an application of this record.
- A grant is one conferral, not one token. One dance minting several tokens stays one grant, and two independent conferrals stay two grants.
- Capabilities declare the grants they need, and the relation stays many-to-many. Discovery answers before any credential exists, which is what the declaration is for.
- A capability handle is non-null if and only if the capability is implemented, all the grants it needs are live, and a subscription-gated Watch has an active subscription. Nothing gates the handle on a runtime connectivity check, and no handle survives its grant epoch. Transport health rides beside an unlocked capability as a reported degradation, and it never removes the handle or moves grant state.
- Degradation stays per grant. A dead grant relocks only the capabilities that need it, and the rest of the connection stays live.
- Availability answers with a reason: the exact missing grants, a missing subscription, or an unsupported capability. A boolean is not an answer.
- Origin-verification material is not a grant product and stays out of the credential, so deliveries remain verifiable while a grant is degraded.
- Connecting and using stay joined only at the grant ledger and the two crossing signals. A conferral flow does not reach into capability wiring, and a capability does not drive guardian interaction.
