# Agents

What an agent is and how it runs: its definition, the model account and model it runs on, and the agent session that takes its turns with Rome's tools. It defines the extension points apps plug into. The words it uses are defined in [`docs/domains/agents.md`](../../../../docs/domains/agents.md).

## Imports

- Agents may import Instance, as [`lint/rules/contexts.ts`](../../../../lint/rules/contexts.ts) checks.
- It is imported by App host, Chats, Concierge, Routines and Webchat.
- Agents never imports Apps. Agents defines the extension points and Apps supplies them, so an adapter that reads what an app ships lives in Apps.
- Agents never imports Connections. An agent never knows which connection carries its chat, and what it needs from a chat reaches it through Chats.
