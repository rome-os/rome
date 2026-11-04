# Agents

What an agent is and how it runs. This context exists in the code and the docs already and is reused as it stands.

## Agent

A named Rome agent, such as main, sales or support. Its definition, model selection and capabilities are in [`concepts/agents.md`](../concepts/agents.md). Nothing in the domain language changes what an agent is.

- In a chat, an agent is a participant ([Chats](chats.md#agent)). It speaks through its own account or answers on the guardian's behalf. When it wakes, what it reads and where it speaks is in [Participation](participation.md).
- How an agent remembers what it observes in a chat or its threads is its own decision. Chats describes participants and messages and says nothing about memory.

## Session

One agent's run of work, made of [turns](#turn). A session is not a chat: a chat is made of messages that participants said, a session of what one agent did (Ouou, 2026-11-04).

- A session is known by Rome's own id. It has one agent for its whole life: switching the agent on an account ends that account's chat sessions rather than changing their agent ([Participation](participation.md#speaker)).
- A session either stands in a chat, as a [chat session](#chat-session), or stands in none, as a [subagent](#subagent), a [fork](#fork) or an [action run](#action-run). Which one follows from what started it, and it never changes: a session is born in a chat or in none, and is never placed in one later.
- The dashboard shows a session as its turns, oldest first, each with its prompt, its steps and its answer. A chat is shown as its messages. The two views read one record, and a turn links the two.
- How a session runs, its model, its trace and its limits, is in [`concepts/sessions.md`](../concepts/sessions.md).

## Turn

One prompt to the agent and the work that follows, until the agent answers or stops. Its full contracts are in [`concepts/sessions.md`](../concepts/sessions.md#turn).

- A turn belongs to one session.
- A turn has a [prompt](#prompt) and, when it ends with one, an [answer](#answer). The steps between them are its trace.

## Prompt

What a turn was asked.

- In a chat session, a prompt is a message of the chat, the one that woke the agent, linked to the turn. The message stays the chat's.
- In a session in no chat, the prompt is the turn's own, kept by the session. It is not a message, and Chats never holds it.
- A prompt names who asked: a participant for a message, the session's [starter](#starter) otherwise.

## Answer

What a turn gave back.

- In a chat session, an answer is the agent's message in the chat, linked to the turn. A turn may answer with several messages, or with none.
- In a session in no chat, the answer is the turn's own, kept by the session, and goes back to its [starter](#starter). It is not a message.

## Chat session

A session that stands in a chat: it has a [speaker](participation.md#speaker) there, one of Rome's accounts with its agent.

- It is born in its chat, as that account, and never placed later. How it is born is in [Participation](participation.md#speaker).
- Its prompts are messages that woke the agent, and its answers are its messages in the chat. Messages it only caught up on are linked to the turn too, as seen, and stay the chat's.
- It ends with its chat, or when the guardian switches the agent on its account.

## Starter

What started a session that stands in no chat, and receives its answers: the parent session's turn for a subagent, the routine or action that ran an action run, the feature that made a fork, such as a recap or turn feedback.

- A starter is not a participant. A session in no chat has no participants, since nothing in it is said in a place.
- The dashboard names the starter where a chat session names its chat: "subagent of main", "run of the routine Morning inbox".

## Subagent

A session that a turn of another session starts to hand work to, and whose answer goes back to that turn. Its starter is that turn.

- The parent turn shows the hand-off as one of its steps, which leads to the subagent's session.
- A subagent of a chat session does not stand in that chat. What it was asked and what it answered are never messages of the chat.

## Fork

A session branched from another session's context at one of its turns. It sees what the source had seen, and nothing it does reaches the source. Its starter is the feature that made it, such as a recap or turn feedback.

## Action run

A session in which an agent runs an [action](../concepts/actions.md), started by a routine or another action. Its starter is what ran it.

- A run can send a message into a chat as any send goes: to a place, from one of Rome's accounts there ([Chats](chats.md#place)), recorded under that account. The message is the chat's, and the run's step leads to it there. Sending does not make the run a chat session, and it is a send, not a reply.

## Decided against

- **A session as a kind of chat.** A chat answers who said what, where and as whom. A subagent's request, a routine's instructions and a fork's question were never said in any place, by any account, so a chat for them would record things no participant said or saw (Ouou, 2026-11-04).
- **Placing a session in a chat after it was born.** Every path that could reach a session before it was placed had to handle a session with no chat, and each send path grew a branch for it. Born in a chat or in none, there is no such state.
