# Access

Who has a role in this Rome, and which. The rest of what Access owns, such as sign-in and the permission on each app, is described in [concepts/people.md](../concepts/people.md#team) and [architecture/access-control.md](../architecture/access-control.md).

In code, the rules of roles are the `Access` class in [`packages/core/src/access/access.ts`](../../packages/core/src/access/access.ts). It knows a person only by id and depends on no other context. The steps Rome takes that also need to know who a person is are in [`packages/core/src/access/application/`](../../packages/core/src/access/application/), which depends on [Identity](identity.md).

## Role

What a person is in this Rome: the guardian, or a member.

- A person has at most one role. A person with none has no access as a member.
- There is at most one guardian. Granting guardian to a person while another person is the guardian is refused, and nothing changes.
- Granting a person the role they have changes nothing.
- The guardian is never demoted: granting the guardian member changes nothing.
- The guardian's role is never revoked. Asking to revoke it is refused, and nothing changes. Revoking the role of a person with none changes nothing.

## Member

A person with a role, the guardian included. A member is a [person](identity.md#person) in Identity, so a member is known by every account of theirs.

- Every other part asks once, with an account, which role its person has. That step asks Identity who the person is and Access which role they have, so no other part asks Identity about roles.
- The members are the one source of which emails may use the dashboard: the `rome-cloud-email` accounts of every person with role member. The dashboard and the auth edge hold an in-memory copy, loaded at startup and refreshed by each save of the invited emails. Rome Cloud receives the same emails.
- The guardian's email is not among them. The guardian's seat says who the guardian is, so inviting the guardian's own email adds no member.

## Steps Rome takes today

These coordinate Identity and Access. They are how Rome uses the rules above now, not rules of roles.

- **A guardian's seat is created.** The guardian's person gets the seat's email as a `rome-cloud-email` account, and is created with the guardian role when there is no guardian. A local password seat has no email and gives no account. An email that another person holds moves to the guardian.
- **A guardian's seat is rebound** to another email. The guardian's person loses the seat's old email and gets the new one. Its other accounts stay, even an email that differs from the seat's, because Identity cannot tell which earlier seat or People link gave the guardian an account. A rebind to another Rome Cloud account with the same email changes nothing.
- **A member is invited** by email. When nobody holds that email as a `rome-cloud-email` account, a new person is created with it as their account. Inviting the guardian's own email leaves them the guardian.
- **A member is removed.** Their role is revoked, then their person and every account of theirs are deleted, and each account then belongs to nobody.
- **The invited emails are saved.** Each listed email is invited, and every member who holds none of them is removed, in one transaction. A save the members cannot take fails, and nothing changes.
- **A member signs in** through Rome Cloud. The person behind the email as a `rome-cloud-email` account, the guardian or a member, gets the avatar Rome Cloud reports and no account, since the email is the account. A sign-in with the guardian's email is the guardian's person. A sign-in by someone with no role creates no person.
- An account that would land on the guardian and on someone else stays with the guardian.
- **Startup.** After migrations, the accounts an earlier build stored move to the sign-in platform: every Rome Cloud id stored as an account is removed, from any person, and each `email` account of a member, which only an invitation gave, becomes the same address on `rome-cloud-email`. The guardian gets the seat's email on `rome-cloud-email` and People's links to it, and loses the seat's address as an `email` account unless People links that address, as an email connection's. No other account is taken away; only a rebind's own step does that. Only the first startup with this step reads the invited emails an older build kept in the `dashboardAccess` setting, and a `settings` key records that it ran, so a later startup never undoes a save. A second run changes nothing. Then the in-memory copy of the members' emails is loaded.

## Retired

- **The invited-email list in the `dashboardAccess` setting.** Nothing reads or writes it after the first startup above. It stays as the last older build wrote it, so a rollback still finds a list. The same record still keeps the save counter Rome Cloud uses to drop an older list.

## Decided against

- **Roles in Identity.** Identity would then answer two questions, and every part that only asks who a sender is would depend on roles.
- **Keeping a removed member's person.** A person kept with no role keeps their accounts, so inviting someone else with one of those accounts later would find the old person.
