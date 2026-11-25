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

## Steps Rome takes today

These coordinate Identity and Access. They are how Rome uses the rules above now, not rules of roles.

- **A guardian's seat is created.** The guardian's person gets the seat's accounts, and is created with the guardian role when there is no guardian. An account that another person holds moves to the guardian.
- **A member is invited** by email. When nobody holds that email, a new person is created with the email as their account. Inviting the guardian's own email leaves them the guardian.
- **A member is removed.** Their role is revoked, then their person and every account of theirs are deleted, and each account then belongs to nobody.
- **The invited emails are saved.** Each listed email is invited, and every member who holds none of them is removed.
- **A member signs in.** Their person gets the account they signed in with. A sign-in by someone with no role creates no person.
- An account that would land on the guardian and on someone else stays with the guardian.

## Decided against

- **Roles in Identity.** Identity would then answer two questions, and every part that only asks who a sender is would depend on roles.
- **Keeping a removed member's person.** A person kept with no role keeps their accounts, so inviting someone else with one of those accounts later would find the old person.
