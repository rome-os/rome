# Access

Who is on the team, and with which role. The rest of what Access owns, such as sign-in and the permission on each app, is described in [concepts/people.md](../concepts/people.md#team) and [architecture/access-control.md](../architecture/access-control.md).

## Team

The persons who use this Rome as the guardian does, each with a role. A person here is a [person](identity.md#person) in Identity, so a team member is known by every account of theirs.

- The team has exactly one guardian. Everyone else on it is a teammate.
- **Adding** a teammate names them by email. When nobody holds that email, the teammate is a new person with the email as their account. Adding the guardian's own email leaves them the guardian.
- **Removing** a teammate deletes the person and every account of theirs, and each account then belongs to nobody.
- The guardian is never removed. Asking to remove them is refused, and nothing changes.
- A **sign-in** by a team member gives their person the account they signed in with. A sign-in by someone off the team makes no person.
- An account that would land on the guardian and on someone else stays with the guardian.

## Role

What a person is on the team: guardian or teammate.

- A person has at most one role. A person with none is not on the team.
- Every other part asks Access once, with an account, which role its person has. Access asks Identity who the person is, so no other part asks Identity about the team.

## Decided against

- **Team membership in Identity.** Identity would then answer two questions, and every part that only asks who a sender is would depend on the team.
- **Keeping a removed teammate's person.** A person kept with no role keeps their accounts, so adding someone else with one of those accounts later would find the old person.
