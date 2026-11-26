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

## Acting for the guardian

A rule on an account: the account acts for the guardian, so work it starts is the guardian's. An agent with an account of its own, such as its own Telegram, acts for the guardian through it. Access holds the rule and not Identity, because it says what the account may do and not whose it is.

- An account has the rule or does not. An account without it does not act for the guardian.
- The guardian or a member who holds the account is let in as themselves, whatever the rule says.
- In code, the rule is [`packages/core/src/access/acts-for-guardian.ts`](../../packages/core/src/access/acts-for-guardian.ts): ask whether an account acts for the guardian, start it, stop it.
- **An agent of the guardian's own Rome Cloud account writes for the first time.** Rome writes a [delegate link](people.md#delegate-link) from its account to the guardian, then gives the account the rule. If the rule cannot be written, the account does not act for the guardian until the next startup imports it from the link. Rome never gives the rule over a link or a dismissal the guardian made, and never again to an agent the guardian removed, whatever it is renamed to.
- **A delegate link is removed or moves to another person.** The account loses the rule in the same transaction.
- **Startup.** After migrations, each account People links to the guardian with a delegate link gets the rule. A second run changes nothing, and no account loses the rule here. A run that fails writes nothing, and the accounts it would have added do not act for the guardian until a later start.

## Steps Rome takes today

These coordinate Identity and Access. They are how Rome uses the rules above now, not rules of roles.

- **A guardian's seat is created.** The guardian's person gets the seat's email as a `rome-cloud-email` account, and is created with the guardian role when there is no guardian. A local password seat has no email and gives no account. An email that another person holds moves to the guardian.
- **A guardian's seat is rebound** to another email. The guardian's person loses the seat's old email and gets the new one. Its other accounts stay, even an email that differs from the seat's, because Identity cannot tell which earlier seat or People link gave the guardian an account. A rebind to another Rome Cloud account with the same email changes nothing.
- **A member is invited** by email. When nobody holds that email as a `rome-cloud-email` account, a new person is created with it as their account. Inviting the guardian's own email leaves them the guardian.
- **A member is removed.** Their role is revoked, then their person and every account of theirs are deleted, and each account then belongs to nobody.
- **The invited emails are saved.** Each listed email is invited, and every member who holds none of them is removed. The same transaction stores the list's next revision, writes the members' emails into the `dashboardAccess` setting's list, and records that revision as the one this build last wrote. The transaction holds the save's own writes and no other request's. A save that cannot be written fails, and nothing changes.
- **A member signs in** through Rome Cloud. The person behind the email as a `rome-cloud-email` account, the guardian or a member, gets the avatar Rome Cloud reports and no account, since the email is the account. A sign-in with the guardian's email is the guardian's person. A sign-in by someone with no role creates no person.
- An account that would land on the guardian and on someone else stays with the guardian.
- **Startup.** After migrations, the accounts an earlier build stored move to the sign-in platform: every Rome Cloud id stored as an account is removed, from any person, and each `email` account of a member, which only an invitation gave, becomes the same address on `rome-cloud-email`. The guardian gets the seat's email on `rome-cloud-email` and People's links to it, and loses the seat's address as an `email` account unless People links that address, as an email connection's. No other account is taken away, since only a rebind's own step does that. The first startup with this step reads the invited emails an older build kept in the `dashboardAccess` setting, unless a save came first. A `settings` key records the revision of that setting this build last read or wrote, so a later startup never undoes a save. A later startup reads the list again only when the setting's revision is higher, because an older build saved the list after a rollback. A second run changes nothing. If the step fails while an older build saved a list it has not read, the members may still hold an email that list removed, so no member is let in, only the guardian, until the next startup reads the list or the guardian saves the members on the settings page, which shows that list meanwhile. Then the in-memory copy of the members' emails is loaded.

## Retired

- **The invited-email list in the `dashboardAccess` setting.** Nothing reads it after the first startup above, unless an older build saves it after a rollback. Each save of the invited emails writes the members' emails into it, so an older build after a rollback reads the right list. The same record still keeps the save counter Rome Cloud uses to drop an older list.

## Decided against

- **Roles in Identity.** Identity would then answer two questions, and every part that only asks who a sender is would depend on roles.
- **Keeping a removed member's person.** A person kept with no role keeps their accounts, so inviting someone else with one of those accounts later would find the old person.
