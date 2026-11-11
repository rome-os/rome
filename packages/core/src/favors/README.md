# Favors

Favor requests: a visitor asks Rome to run an app action for them, and Rome fulfils it through Rome Cloud.

## Imports

- Favors may import Access, Apps and Instance, as [`lint/rules/contexts.ts`](../../../../lint/rules/contexts.ts) checks.
- It is imported by App host only.
- No agent takes part in a favor request, so Favors never imports Agents.
- A favor request names no chat, account or connection, and knows its visitor by their Rome Cloud account, not as a person. So Favors never imports Chats, Connections or People.
