# Sessions

The records of each agent session, for chats on every platform (`rome_sessions`), and where each session speaks: the place, the account of Rome's it speaks as, and its agent. Chats, Connections, Agents and Webchat read and write those records through here, so none of them depends on Webchat for them.

## Imports

- Sessions is not a context in [`lint/rules/contexts.ts`](../../../../lint/rules/contexts.ts) yet, so nothing checks what it imports or what imports it.
