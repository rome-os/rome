# Desktops

The machines Rome can reach and what it can do on them: the named desktops, computer use, and Rome nodes.

## Imports

- Desktops may import Access and Instance, as [`lint/rules/contexts.ts`](../../../../lint/rules/contexts.ts) checks.
- It is imported by Connections only.
- Desktops never names a chat, account, person, app, favor or connection, and never knows what woke an agent. It answers whoever asks.
- A connection that needs a screen, such as WeChat's own-account connection, asks Desktops for one.
