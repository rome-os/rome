# Feature Requests

A **feature request** is a GitHub issue for a pain, gap, or missing capability where the change is undecided. It exists to start a design conversation, not to queue implementation. [github-issues.md](github-issues.md) holds the rules every issue shares — the title shape, the Situation section, the type labels — and wins where a rule here conflicts with it.

A pain point with no feature attached still files as a feature request. The Pain section is the request. When the change is already decided and scoped, file a [task spec](github-issues-task-spec.md) instead.

## Title

A feature request title states the pain in present tense, not the wished-for feature.

> Prefer: "connector: adding an OAuth provider takes a day of hand-written boilerplate".
> Over: "connector: build a provider scaffolding CLI".

## Body

Required sections: Situation, Pain. A **Possible directions** section may follow.

- **Pain** — what the gap costs and who pays it: the workaround in use, the time lost, the thing a user cannot do. It links the PRs, incidents, or threads where the gap bit.
- **Possible directions** — sketches of the design space, and picks nothing. Each direction carries its main tension in a line.

Pain carries evidence. A pain nobody can point to is a preference.

> Prefer: "two contributors asked in #rome-dev how to start a connector and were pointed at a diff of two PRs (#1225, #1480)."
> Over: "the connector authoring experience could be better."

When the filer arrives with a solution in mind, the underlying gap goes in Situation and Pain, and the solution enters Possible directions as one candidate.

## Closing

A feature request closes with a decision, stated in a closing comment: the task specs it spun out, named by number, or why the pain stays unaddressed. No PR closes a feature request directly — implementation flows through the task specs it produces. A decision that keeps constraining diffs after the work ships [earns an ADR](adrs.md).

## Labels

A feature request carries the `feature-request` label and never carries `ready-for-agent`.
