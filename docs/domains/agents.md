# Agents

What an agent is and how it runs. This context exists in the code and the docs already and is reused as it stands.

## Agent

A named Rome agent, such as main, sales or support. Its definition, model selection and capabilities are in [`concepts/agents.md`](../concepts/agents.md). Nothing in the domain language changes what an agent is.

- In a chat, an agent is a participant ([Chats](chats.md#agent)). It speaks through its own account or answers on the guardian's behalf. When it wakes, what it reads and where it speaks is in [Participation](participation.md).
- How an agent remembers what it observes in a chat or its threads is its own decision. Chats describes participants and messages and says nothing about memory.
