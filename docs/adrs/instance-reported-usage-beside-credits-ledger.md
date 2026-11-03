# Instance-reported usage sits beside the Rome credits ledger, joined by the provider's turn id

- **Status**: Accepted
- **Date**: 2026-10-06
- **Concept**: [Rome Cloud — Usage reporting](../concepts/rome-cloud.md#usage-reporting)

## Context

Rome Cloud needs to know how each signed-in instance is used: which turns ran, where they came from, and how many tokens they spent. The answer feeds product analytics first. Billing is expected to read the same data later, so its shape has to hold up when money depends on it.

Rome Cloud already holds one usage record. Its inference gateway writes a row to `inference_requests` for every model request it serves on Rome credits, and it settles the account balance from that row. The gateway observes those requests itself, so the row is evidence Rome Cloud can charge against.

Most turns never reach the gateway. A guardian can run Codex on their own API key or ChatGPT plan, and Claude on an Anthropic key or a Claude subscription. Only the instance sees those turns, so only the instance can report them. The instance runs on hardware the guardian controls, which makes its reports claims rather than evidence.

The common design for metering is one usage table that every source writes into and that billing reads. Here that table would mix rows Rome Cloud observed with rows a client asserted. The gateway's ledger also carries machinery that rejects client rows. A check constraint requires a positive credit hold, and the rate and concurrency limits count an account's recent ledger rows.

A turn and a gateway request are different units. One turn makes one gateway request per model step, so a tool-using turn makes several. The instance knows its turns, and the gateway knows its requests. A join between them needs an id that both sides already see. Codex supplies one: it sends its own turn id in the `x-codex-turn-metadata` header of every model request, and Rome receives the same id from `turn/start`.

## Decision

Instances report usage as their own per-turn and per-action-run events, stored in a table separate from the credits ledger. The gateway records the client's turn id on each request, and Rome Cloud joins the two on it. Rome credit charges come only from the gateway's ledger, and an instance-reported event never moves money.

## Alternatives

- **Write instance reports into `inference_requests` as unfunded rows.** Rejected because the ledger's constraints and limits assume every row is a credit hold. An unfunded row fails the hold check, and BYOK traffic would count against the same account's credit rate limit and throttle it.
- **Charge Rome credits from the instance's reported tokens and drop the gateway ledger.** Rejected because a guardian controls the reporting process and can under-report. A charge must rest on what Rome Cloud observed itself.
- **Report only aggregates, such as hourly totals per kind and model.** Rejected because a total cannot be split again. Billing, reconciliation against the gateway, and corrections all need the per-turn record, and the per-turn record still yields any total.
- **Have Rome mint a usage id and send it to the gateway as a request header.** Rejected because Codex runs as one shared app-server process whose provider headers are fixed at spawn. Rome cannot set a per-turn header, and Codex already sends a per-turn id of its own.
- **Join on time windows and the model name instead of an id.** Rejected because concurrent turns on one instance overlap in time and often share a model. The join would attribute charges to the wrong turn.
- **Let Rome Cloud reject events whose kind, provider, or funding it does not recognize.** Rejected because instances update on their own schedule. An instance newer than Rome Cloud would lose every event that uses a new value, so categorical fields are an open vocabulary and only structure and counts are validated.
- **Give the guardian a switch to turn reporting off.** Rejected because billing is expected to read these events, and a guardian cannot opt billed usage out of the record it is billed from.

## Consequences

Every funding source is visible in one place without loosening the ledger that moves money. A usage view reads both tables: tokens from the events, and charges from the gateway rows joined on `provider_turn_id`. A credits charge with no matching event stays visible as unattributed, so a missing report never hides a charge.

Billing that wants to charge for non-credit usage, such as a platform fee on BYOK turns, has to price self-reported numbers. That is safe where an instance runs a build Rome controls, and it carries under-reporting risk on a self-hosted instance. The gateway-observed credits path does not carry that risk.

The join depends on Codex continuing to send `turn_id` in `x-codex-turn-metadata`. That header is not a documented contract. A Codex upgrade that drops it leaves events and charges unjoined but still correct on their own. The bundled-binary integration test asserts that the header carries the same id `turn/start` returns. A provider other than Codex reaching the gateway needs its own way to carry a turn id.

Future diffs must respect four things. No code path debits a balance from a usage event. Event ids stay stable per turn and per root action execution, because delivery is at-least-once and Rome Cloud deduplicates on them. Events carry no content, contact, or routine name. Attribution that needs session lineage resolves it when the event is recorded, and copies nothing onto the parent, as [the subagent cost decision](child-session-owns-subagent-stream-and-cost.md) requires.
