# Access

Who may open what: the `Principal` asking (the guardian, a signed-in visitor, or someone not signed in) and the `Permission` on each thing. It also owns guardian and visitor sign-in, and the dashboard allow-list, whose visitors are dashboard admins.

Its domain is the `Access` class in [`access.ts`](access.ts): it answers who has a role in this Rome and which, knows persons only by id, and depends on nothing. Sessions, app permissions and the rule that an account acts for the guardian ([`acts-for-guardian.ts`](acts-for-guardian.ts)) are separate modules of the context.

[`application/`](application/) holds the steps Rome takes on members that need Identity as well: answering the role of an account's person, listing members with their persons and accounts, the guardian's seat being created, inviting and removing a member, saving the invited emails, a member signing in, the startup backfill, and the startup import of accounts acting for the guardian. It depends on Identity. The words are defined in [`docs/domains/access.md`](../../../../docs/domains/access.md).
