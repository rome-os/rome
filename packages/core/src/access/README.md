# Access

Who may open what: the `Principal` asking (the guardian, a signed-in visitor, or someone not signed in) and the `Permission` on each thing. It also owns guardian and visitor sign-in, and the dashboard allow-list, whose visitors are dashboard admins.

Its own service is the `Access` class in [`access.ts`](access.ts): it answers who is on the team and in which role. Sessions and app permissions are separate modules of the context.
