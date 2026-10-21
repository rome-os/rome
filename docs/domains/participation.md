# Participation

When an agent takes part in a chat: what wakes it, what it reads, and where it speaks. Participation reads the record [Chats](chats.md) keeps and speaks back into it, and starts a turn of an [agent](agents.md). The pattern both ways is the same: Chats keeps the record and offers it, the agent judges what to read and where to speak, and a guardrail bounds the speaking.

## Wake

The moment a message is judged to need the agent and the agent starts a turn. The chat's [reply rule](chats.md#reply-rule) decides it.

- Not every message wakes the agent. Under "when it is needed" a lightweight check decides whether the message needs the agent, and a mention always does.
- A woken agent first catches up on what it has not seen, then acts.
- Waking and speaking are two decisions. A woken agent may read, remember and act with its tools, and end its turn without saying anything in the chat.

## Projection

The agent's working memory of a chat: a view built from the chat's messages, not the record itself. [Chats](chats.md) keeps the record and offers it. What the agent keeps of it is its own business ([Agents](agents.md)).

- There is one default view and no setting. When the agent wakes, it reads the recent messages of the place the waking message was said in: the chat itself, or the thread, which starts with the message it was opened from. A message alone rarely carries the whole context, in a group or in a direct message.
- Whoever writes chooses the place. Mentioning the agent in a thread hands it a task with the thread as its context. Asking in the open chat gives it the chat around the question.
- How far back "recent" reaches is the agent's own bound.
- Beyond the default view, the agent can read more of the chat on its own judgement: further back, the chat around a thread, other threads in the chat.

## Reply

What the agent says back after a wake, through the account it was woken on.

- The agent decides where in the chat a reply goes: the thread the message was said in, the chat itself, or another of its threads.
- A reply stays in the chat the agent was woken in. A message to any other chat pauses on an approval card for the guardian and leaves only once they allow it.
- A reply is a message like any other, said by the agent as its own account or on the guardian's behalf under theirs, as the kind of link says.

## Decided against

- **A projection setting per agent or per chat.** One default serves every chat: the place the waking message was said in. A setting would move a reading decision that belongs to the agent into chat configuration.
- **A thread as the boundary of the agent's memory.** What the agent remembers is its own decision, in Agents. Participation says only what it is offered at a wake.
- **Refusing every message outside the woken chat.** The guardian sometimes wants the agent to carry something across chats. An approval card keeps that possible and keeps the guardian in the loop.
