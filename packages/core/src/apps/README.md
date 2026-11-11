# Apps

What an app is and its whole life: the catalog, install, upgrade and uninstall, artifacts, the store, remix and publish, and the actions and hooks an app runs.

## Imports

- Apps may import Access and Instance, as [`lint/rules/contexts.ts`](../../../../lint/rules/contexts.ts) checks.
- It is imported by App host, Chats, Concierge, Connections, Favors, People, Relay, Routines and Webchat.
- Apps is foundational. It defines what an app receives and runs it, and App host fills that in from the other contexts, so Apps imports nothing beyond Access and Instance.
- Apps never imports Favors, since a favor request exists to run an app action.
