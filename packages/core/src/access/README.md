# Access

Who may open what: the `Principal` asking (the guardian, a signed-in visitor, or someone not signed in) and the `Permission` on each thing. It also owns guardian and visitor sign-in, and the dashboard allow-list.

## Imports

- Access may import Instance, as [`lint/rules/contexts.ts`](../../../../lint/rules/contexts.ts) checks.
- It is imported by App host, Apps, Chats, Concierge, Desktops, Favors, Routines and Webchat.
