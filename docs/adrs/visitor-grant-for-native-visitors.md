# Native visitors sign in through the visitor grant, not the owner's

- **Status**: Accepted
- **Date**: 2026-11-06
- **Concept**: [Rome Cloud — Instance sign-in](../concepts/rome-cloud.md#instance-sign-in), [Access control — Visitor sign-in](../architecture/access-control.md#visitor-sign-in)

## Context

Rome Cloud has two grants an instance redeems. The owner grant (`/oauth2/authorize` and `/oauth2/token`) yields a signed identity assertion, and the instance turns it into a guardian credential. The visitor grant (`/instance/authorize` and `/api/account/session`) yields an account identity. The instance turns that into a visitor credential once its own allow-list names the account's email.

The native app signs the owner in through the owner grant. It also has to sign in a [visitor](../concepts/people.md#visitor) on the instance's dashboard allow-list.

Instances update on their own schedule and can be rolled back to an older build. Every instance build that exists takes any code from the owner grant as the owner's. Builds before the native owner sign-in checked the guardian seat also bound the seat to whatever account signed in.

## Decision

The native app signs a dashboard visitor in through the visitor grant, the one the browser visitor flow uses. Rome Cloud issues a visitor-grant code for the phone. The instance redeems it at the account session endpoint and returns the visitor credential as JSON. The owner grant stays owner-only and carries no role.

## Alternatives

- **Issue owner-grant codes to visitors and name the role in a signed `instance_role` claim.** Rejected because a build that predates the claim takes such a code as the owner's. Rome Cloud cannot tell which build an instance runs at the moment it issues a code. A gate on the instance's version or on a synced allow-list holds only until the instance is rolled back. A rolled-back instance would hand a visitor a guardian credential and could rebind its seat to them.
- **Add a third grant only for native visitors.** Rejected because the visitor grant already returns what the instance needs. The allow-list re-check is the same for both channels. A third grant would be one more redemption path to keep in step with the other two.

## Consequences

No instance build, old or new, can take a visitor code for the owner's, because the two grants redeem at different endpoints. An instance without the native visitor endpoints answers 404, and the phone shows that the instance needs an update. Rome Cloud needs no gate before it issues native visitor codes.

The native visitor session carries the same favor viewer token as the browser one, because both come from the same account session exchange.

Future diffs must respect three things. The owner grant never issues a code to an account that does not own the instance. No claim on that grant changes what the instance issues. A native sign-in and a browser sign-in each finish only at their own endpoint.
