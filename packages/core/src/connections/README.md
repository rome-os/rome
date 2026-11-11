# Connections

What access Rome has to which external account: a connection, its one grant, the setup flow that makes it, and the adapters that carry messages in and out. It also owns what an app may do through a connection. The words it uses are defined in [`docs/domains/connections.md`](../../../../docs/domains/connections.md).

## Imports

- Connections may import Apps, Chats, Desktops, Instance, Participation and People, as [`lint/rules/contexts.ts`](../../../../lint/rules/contexts.ts) checks.
- It is imported by App host, Chats, Concierge and People.
- Connections never imports Webchat. The dashboard chat is Rome's own chat, not a connection.
