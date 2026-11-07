# Agents

What an agent is and how it runs. This context exists in the code and the docs already and is reused as it stands.

## Agent

A named Rome agent, such as main, sales or support. Its definition, model selection and capabilities are in [`concepts/agents.md`](../concepts/agents.md). Nothing in the domain language changes what an agent is.

- In a chat, an agent is a participant ([Chats](chats.md#agent)). It speaks through its own account or answers on the guardian's behalf. When it wakes, what it reads and where it speaks is in [Participation](participation.md).
- How an agent remembers what it observes in a chat or its threads is its own decision. Chats describes participants and messages and says nothing about memory.

## Session

One agent's run of work: its turns, in order (Ouou, 2026-11-04). A session is not a chat, and the two are independent: a chat is what participants said, a session is what one agent did.

- A session is known by Rome's own id. It has one agent for its whole life.
- A session may have a [continuity key](#continuity-key), and may have a parent turn: a turn of another session it was started from with a fresh context, or branched from with that turn's context. A subagent is the first, a fork the second.
- A session knows no chat. Whether one stands in a chat is Participation's fact: a [speaker](participation.md#speaker) points at it or none does.
- Deleting a chat changes nothing in a session.

## Continuity key

What the opener of a session, such as a chat, an app or Concierge, mints so that it finds its current session again after a reset, such as New Chat (Ouou, 2026-11-06).

- It is opaque. Sessions never reads anything into it.
- A speaker's continuity key is derived by Participation from its place and its account.

## Turn

One prompt to the agent and the work that follows, until the agent answers or stops. Its contracts are in [`concepts/sessions.md`](../concepts/sessions.md#turn).

- A turn has a prompt, an answer when it ends with one, and a trace: what the agent did between them, its steps and tool calls.
- The prompt, the answer and the trace are the turn's own and belong to its session, never to a chat (Ouou, 2026-11-05).
- When a prompt came from a chat or an answer went to one, Participation links the message to the turn: this message prompted, or was said by, this turn. The link is the only tie between a chat and a session.
- A session sends into a chat as any send goes: to a place, from one of Rome's accounts there ([Chats](chats.md#place)).

## Decided against

- **A session as a kind of chat.** A subagent's task, a routine's instructions and a fork's question were never said in any place, by any account. A chat for them would record things no participant said or saw (Ouou, 2026-11-04).
- **Turns and traces kept by Chats.** A chat holds what participants said. A turn and its trace are what one agent did (Ouou, 2026-11-05).
- **Kinds of session, such as chat session, subagent, fork and action run, each with its own rules.** Every kind added cases to the rules for prompts, answers and lifetime. One session with an optional parent turn and an optional continuity key covers them all (Ouou, 2026-11-07).
- **A starter, naming what opened a session in no chat.** It follows from the continuity key or the parent turn, and a subagent's answer going back is the parent turn's own tool call.
