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
- The members are the one source of which emails are invited: the `rome-cloud-email` accounts of every person with role member. The settings page and Rome Cloud receive these emails. The dashboard and the auth edge hold an in-memory copy of the members' sign-in emails and, apart from them, the email of the guardian's seat. Only the members' emails say whether anyone besides the guardian may open the dashboard. They alone decide whether the guardian's chats stay private, whether the login page offers sign-in to members, and whether a Rome Cloud account refused as not the owner is sent on to sign in as a member. The sign-in and session gates open when a member is invited or the seat has an email, so the guardian's person can sign in with the seat's email when no member is invited. A Rome Cloud sign-in with a member's email or the seat's email is let in, since a sign-in with the seat's email is the guardian's person. Another email the guardian's person holds, such as an older seat email left after a failed rebind, is not let in. The copy is loaded at startup and reloaded after each save of the invited emails and each change of the guardian's seat, the one at startup included.
- The guardian's email is not among the invited emails. The guardian's seat says who the guardian is, so inviting the guardian's own email adds no member.

## Steps Rome takes today

These coordinate Identity and Access. They are how Rome uses the rules above now, not rules of roles.

- **A guardian's seat is created.** The guardian's person gets the seat's email as a `rome-cloud-email` account and the same address as an `email` account, so mail from it to Rome's inbox is the guardian's. The person is created with the guardian role when there is no guardian. A local password seat has no email and gives no account. An address that another person holds, on either platform, moves to the guardian.
- **A guardian's seat is rebound** to another email. The guardian's person loses the seat's old email on both platforms and gets the new one on both. Its other accounts stay, even an email that differs from the seat's, because Identity cannot tell which earlier seat or People link gave the guardian an account. A rebind to another Rome Cloud account with the same email changes nothing.
- **A member is invited** by email. When nobody holds that email as a `rome-cloud-email` account, a new person is created with it as their account. The member's person also gets the address as an `email` account, so mail from it to Rome's inbox is theirs. One another person holds moves to the member, and the move is logged. Inviting the guardian's own email leaves them the guardian.
- **A member is removed.** Their role is revoked, then their person and every account of theirs are deleted, and each account then belongs to nobody.
- **The invited emails are saved.** Each listed email is invited, and every member who holds none of them is removed. The same transaction stores the list's next revision, writes the members' emails into the `dashboardAccess` setting's list, and records that revision as the one this build last wrote. The transaction holds the save's own writes and no other request's. A save that cannot be written fails, and nothing changes.
- **A member signs in** through Rome Cloud. The person behind the email as a `rome-cloud-email` account, the guardian or a member, gets the avatar Rome Cloud reports and no account, since the email is the account. A sign-in with the guardian's email is the guardian's person. A sign-in by someone with no role creates no person.
- An account that would land on the guardian and on someone else stays with the guardian.
- **People links an account to the guardian, or stops linking it.** In the same transaction, the account becomes the guardian's person's, or stops being theirs when that person holds it and it is not the `email` account of a sign-in of theirs. A re-point is both: the old id goes and the new one comes. A delegate link reaches Identity like any other, so the account of an agent in the guardian's own Rome Cloud account is the guardian's, the same as a Slack account the guardian owns. A Rome Cloud id never reaches Identity. An account People never linked to the guardian, such as one added with an account code, is left alone. When Identity cannot be written, People's write fails with it.
- **The guardian connects their own account.** A connection signed in as the account that gave Rome the access, such as the guardian's WhatsApp, Telegram or LinkedIn, gives that account to the guardian's person at once, with no code, in the same transaction as the credential. When Identity cannot be written, the connect fails with its credential unsaved. Connecting a bot or an app, such as Rome's Slack app or a Discord bot, says nothing about whose any account is: the guardian makes their account on that platform theirs with an account code, like any member. Connecting writes nothing to People.
- **Startup.** After migrations, the accounts an earlier build stored move to the sign-in platform: every Rome Cloud id stored as an account is removed, from any person, and each `email` account of a member with no sign-in of the same address gets that sign-in, since only an invitation gave it. The guardian gets the seat's email on `rome-cloud-email` and People's links to it, delegate links included, which repairs a link an earlier build wrote only to People. Every `rome-cloud-email` account of the guardian and the members then gives its person the same address on `email`. No account is taken away, since only a rebind's own step does that. An id People re-pointed before links reached Identity as they were written stays the guardian's, since Identity cannot tell it from an account added with a code. The first startup with this step reads the invited emails an older build kept in the `dashboardAccess` setting, unless a save came first. A `settings` key records the revision of that setting this build last read or wrote, so a later startup never undoes a save. A later startup reads the list again only when the setting's revision is higher, because an older build saved the list after a rollback. A second run changes nothing. If the step fails while an older build saved a list it has not read, the members may still hold an email that list removed, so no member is let in, only the guardian, until the next startup reads the list or the guardian saves the members on the settings page, which shows that list meanwhile. Then the in-memory copy of the members' emails is loaded.

## Retired

- **The invited-email list in the `dashboardAccess` setting.** Nothing reads it after the first startup above, unless an older build saves it after a rollback. Each save of the invited emails writes the members' emails into it, so an older build after a rollback reads the right list. The same record still keeps the save counter Rome Cloud uses to drop an older list.

## Decided against

- **Roles in Identity.** Identity would then answer two questions, and every part that only asks who a sender is would depend on roles.
- **Keeping a removed member's person.** A person kept with no role keeps their accounts, so inviting someone else with one of those accounts later would find the old person.
