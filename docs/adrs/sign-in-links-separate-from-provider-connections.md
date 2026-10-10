# Sign-in links are separate from provider connections, and login holds no token

- **Status**: Accepted
- **Date**: 2026-08-11
- **Concept**: [Rome Cloud](../concepts/rome-cloud.md)

## Context

[Rome Cloud](../concepts/rome-cloud.md) plays two roles against the same external providers, and the two roles are distinct trust roots. As the identity provider it answers "this Rome user is this Google subject", which is what a sign-in matches on. As the third-party OAuth broker it holds a durable, refreshable grant that a Rome instance redeems and acts with.

The two callers share a provider name and nothing else. Sign-in needs the provider subject and a verified email, reads the profile once, and never touches the provider again. A connection needs a refresh token that stays alive for months so the instance can call Gmail or Calendar on the guardian's behalf.

Their lifecycles pull apart on three axes. Revocation: a guardian who disconnects Gmail expects to keep logging in, and a guardian who unlinks a sign-in provider expects nothing about their granted access to change. Scope: identity wants `openid email profile`, and a real connection wants the resource scopes the work needs. Cardinality: one external account maps to one Rome user for sign-in, while a guardian can reasonably connect several accounts of the same provider.

Sign-in is an authentication act. A login path that keeps the access token from its own code exchange turns every account that ever signed in into a holder of a provider credential nobody asked Rome to hold. It also makes the honest state of a new account — signed in, having authorized nothing — impossible to represent.

The industry default collapses all of this into one record. Social-login stacks in the Auth.js lineage keep a single account row keyed on the provider and the provider account id, carrying the access and refresh tokens next to the identity fields. That default has already shipped here: a single `(user_id, provider)` slot served both callers, with a rebind guard that existed only to police it. Splitting the endpoints and their trust roots did not dislodge it — the brokering surface separated the routes and deliberately left the shared row alone.

## Decision

Sign-in linkage and brokered resource grants live in separate records with independent lifecycles, joined by nothing stronger than the user and the provider account they name. The login path persists no provider token.

## Alternatives

- **Keep one row per user and provider carrying both the identity subject and the token, as the social-login default does.** Rejected because a single slot turns three independent lifecycles into collisions: dropping a resource grant unlinks sign-in, one scope set has to serve both identity and resource access, and the row that anchors identity caps the guardian at one connected account per provider.
- **Keep one row and add a flag, or a nullable token column, to tell identity records from connection records.** Rejected because the flag labels the collision without removing it. The key still holds one slot per user and provider, so token inheritance on reconnect stays scoped to that slot and a refresh token can cross provider accounts.
- **Keep the shared slot and defend it with a rebind guard that refuses a connect to a different provider account.** Rejected because the guard buys safety by forbidding a legitimate act. Connecting an account other than the sign-in account is normal, and the guard makes the second account unreachable rather than merely awkward.
- **Split the endpoints and their trust roots, and leave storage shared.** Rejected because the collision lives in the key, not the route. Two endpoints writing one uniquely keyed row still overwrite each other's provider account id and scopes, which is the state the route split left in place and the storage split had to finish.
- **Let login keep the access token it already exchanged, since the code exchange hands one over anyway.** Rejected because incidental custody is still custody. Every signed-in account becomes a credential holder without a grant behind it, and the correct state of an account that has connected nothing stops being representable.
- **Drop the token from the login callback but let the pending registration record carry it through signup.** Rejected because the signup handoff is the same authentication act, and a token parked in a short-lived row is the same credential under a shorter name.
- **Own the connection from the identity link with a foreign key, so a grant hangs off the account it was authorized with.** Rejected because that re-couples the lifecycles the split exists to separate. A guardian can connect a provider they never sign in with, which leaves no link to hang the grant on, and unlinking a sign-in would cascade into live grants.

## Consequences

Revocation stops needing care. A returning sign-in cannot disturb a resource connection and a disconnect cannot unlink sign-in, because no code path reaches both records. A guardian holds several connections for one provider without touching the sign-in anchor, and connecting an account other than the sign-in account is an ordinary act rather than an error. Login asks for identity scopes only, so the resource side is free to ask for exactly what its work needs.

The costs land on reads and on migration. A surface answering "what does this guardian have with Google" reads two records instead of one. Several connections per provider means every read surface picks deterministically or shows all of them, and the connection settings surface carries that choice. Reconnect flows scope token inheritance to the user, the provider, and the provider account together, which is more key than a single per-provider slot carries. Moving identity data out of a shared row fails loudly on collision, because the identity key is stricter than a per-user-and-provider key.

This record governs Rome Cloud's storage, which lives in the [`rome-cloud`](https://github.com/amantru/rome-cloud) repository. A Rome instance is a consumer of the brokered grant, not a second home for the split. Its `connections` table holds one row per provider, so the instance binds a single account per provider and stores token material on that provider's grant. The multi-account cardinality this decision buys is a Rome Cloud-side property, and an instance-side surface that needs several accounts of one provider is a change to that table rather than an application of this record.

Future diffs must respect:

- Sign-in linkage and brokered grants stay in separate records with independent lifecycles. Reading both in one query is fine. Merging them into one row reopens this record.
- The login path persists no provider token — not on the identity link, not on a pending registration, not in a session.
- Identity is globally unique on the provider and the provider account: one external account maps to one Rome user, and one sign-in subject per provider per user.
- A Rome Cloud connection keys on the user, the provider, and the provider account, so a guardian can hold several. New dimensions such as per-instance rows are additive on that key and never a return to one slot per provider.
- Token inheritance on reconnect stays scoped to the same provider account. Nothing reintroduces a shared slot, and nothing reintroduces a rebind guard to police one.
- The instance-side `connections` table is out of this record's scope. It binds one account per provider by design, and widening it to several is its own decision rather than a consequence of this one.
- Login requests identity scopes only. A login path that asks for resource scopes is a merge of the two roles by another route.
