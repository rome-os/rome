# The instance syncs its dashboard allow-list to Rome Cloud

- **Status**: Accepted
- **Date**: 2026-11-05
- **Concept**: [Rome Cloud — Instance sign-in](../concepts/rome-cloud.md#instance-sign-in), [Access control — Visitor sign-in](../architecture/access-control.md#visitor-sign-in)

## Context

The native app lists instances from Rome Cloud and signs in to one through a code Rome Cloud issues. A [visitor](../concepts/people.md#visitor) on an instance's dashboard allow-list should see that instance in the list. They should sign in to it from the phone, as they can from a browser.

The allow-list lives on the instance. The guardian edits it in the dashboard, and the instance re-checks it on every request. Rome Cloud knows which instances an account owns, but it does not know which instances list an account's email. Listing a visitor's instances needs that answer at list time, across every instance, for one account.

Instances run on hardware Rome Cloud does not reach on demand. A desktop instance sleeps, goes offline, or sits behind a network that blocks inbound calls. A hosted instance can be stopped or mid-upgrade.

## Decision

Each instance sends its whole dashboard allow-list to Rome Cloud whenever the guardian saves it, and once at start. Every save carries a revision that only grows. Rome Cloud applies a list whose revision is at least the one it holds, and answers whether it applied it. Rome Cloud uses its copy only to list instances and issue visitor codes. The instance stays the final judge: it re-checks its own allow-list when it redeems a visitor code and on every request after.

## Alternatives

- **Rome Cloud records the accounts that sign in to an instance as visitors, and lists those.** Rejected because a visitor would see an instance on the phone only after signing in to it from a browser. An invited visitor who has never opened the dashboard would see nothing, and a removed visitor would keep seeing the instance until something cleared the record.
- **Carry the allow-list on the identity heartbeat the instance already sends.** Rejected because the heartbeat runs on a fixed interval, so a guardian's change would reach the list only at the next beat. The heartbeat proves the instance's identity and has nothing to do with access policy. Every heartbeat would carry the list whether it changed.
- **Rome Cloud asks each instance at list time whether an email is on its list.** Rejected because one list request would fan out to every instance. An offline or sleeping instance would hold up the answer or drop out of it. It would also let anyone with a Rome Cloud account probe which instances list a given email.

## Consequences

Rome Cloud holds a copy of every instance's visitor emails. The copy can lag the instance when a sync is still in flight or failed. A lagging copy can only show an instance its visitor cannot open, or hide one they can. It never lets anyone in, because the instance refuses a visitor its own list does not name.

Delivery runs in the background and never fails or slows the save. A failed send retries with backoff, and only the newest list is ever sent. A newer revision that reaches Rome Cloud first wins over an older one that arrives late. A list counts as delivered only when Rome Cloud says it applied it. When Rome Cloud holds a higher revision than the instance, as after a database reset or a restore from an older backup, it does not apply the list. The instance then stores a revision past Rome Cloud's and sends the list again. An unlinked instance sends nothing and sends its list once it links.

Rome Cloud keeps nothing for a listed email that has no account yet, and reports those emails back. When one of them signs in as a visitor, the instance sends its list again so Rome Cloud can match the new account. Other sign-ins send nothing.

Rome Cloud deploys the endpoint before instances start calling it. A Rome Cloud without it answers 404, which the instance does not retry until its next save, boot, or link.

The instance refuses to save a list longer than Rome Cloud accepts, 500 addresses of up to 320 characters each, so a sync never fails on size.

Future diffs must respect two things. No sign-in path trusts Rome Cloud's copy of the list in place of the instance's own. Logs about the sync and about sign-in name counts, revisions, and outcomes, never an email.
