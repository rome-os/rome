# Participation

When an agent takes part in a chat. The code here holds only the per-chat queue of inbound messages and the rule that keeps a message that was only a mention. The words it uses are defined in [`docs/domains/participation.md`](../../../../docs/domains/participation.md).

## Imports

- Participation may import no other context, as [`lint/rules/contexts.ts`](../../../../lint/rules/contexts.ts) checks.
- It is imported by Chats, Connections and Webchat.
