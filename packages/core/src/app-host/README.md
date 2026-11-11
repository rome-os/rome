# App host

Builds each app's `ctx` from every other context, runs the app worker, and loads the agents and skills apps ship.

## Imports

- App host may import Access, Agents, Apps, Chats, Concierge, Connections, Favors, Instance, People, Relay, Routines and Webchat, as [`lint/rules/contexts.ts`](../../../../lint/rules/contexts.ts) checks.
- No context imports App host. `index.ts` and the worker's entry point start it.
