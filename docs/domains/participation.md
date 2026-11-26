# Participation

When an agent takes part in a chat: what wakes it, what it reads, and where it speaks. Participation reads the record [Chats](chats.md) keeps and speaks back into it, and starts a turn of an [agent](agents.md). The pattern both ways is the same: Chats keeps the record and offers it, the agent judges what to read and where to speak, and a guardrail bounds the speaking.

## Speaker

A speaker is one of Rome's accounts in a place, with the agent that speaks for it there. It is read off the agent's session, not stored.

- A session is in a chat when it has a speaker there. The session keeps its own id. No table holds speakers and nothing names one by an id of its own.

## Entry

Whether what someone says or presses on a connection may start anything. [Access](access.md) answers it, once, for the account the connection names, when the connection hands it in. A message, a command and a press all pass the one place that asks, before any agent or app sees them.

- The guardian, a member, and an agent acting for the guardian ([delegate link](people.md#delegate-link)) are let in, as they are at that moment.
- Someone nobody in Rome holds is **unknown**. Anyone else is refused: a person with no role, a member whose sign-in Rome cannot find, a sender whose address the connection could not verify, and everyone when no answer can be had.
- The answer is asked before anything hears the message, and stays with it. The message of someone not let in is recorded in its chat and wakes no agent, and no app hears it. An agent woken later may read it.
- What a message starts is the work of who said it, so a turn acts for the guardian or the member it was let in for, and nothing inside asks again.
- A [command](connections.md#command) and `/stop` pass the same entry. Anyone let in uses every command, and stops any turn. Anyone else's does nothing, and a refusal shows only to them. The same holds for a press on a card, and a Feishu group's settings card is sent only when someone let in asks for it.
- Whom the wake gate would wake for, and what Rome starts itself, are other questions: entry comes before the one and never asks about the other.
- A message from an unknown sender that addresses one of Rome's [own accounts](chats.md#own-account) can be told of once it is on record, at most once, and nothing waits for that. What a bot or an app posted, and what one of Rome's accounts said, is never told of.
- Rome answers such a sender with a link to the dashboard's connect page, where a person gets a code to send back. The link is the same for everyone, so Rome answers in the chat itself, to the sender alone where the connection offers that, at most once a day for an account. An answer the whole chat sees goes to a chat at most once in ten minutes, and an account it holds back is answered later.

## Wake

The moment a message is judged to need the agent and the agent starts a turn. The chat's [reply rule](chats.md#reply-rule) decides it.

- The wake is decided on a message already recorded in its chat. A message that wakes no agent stays in the record, and the agent reads it when it next catches up. Until its wake is decided, no turn catches up on it, since it may yet start a turn of its own.
- Not every message wakes the agent. Under "when it is needed" a lightweight check decides whether the message needs the agent, and a mention always does.
- What the guardian writes in an [assistant's](chats.md#assistant) chat wakes no agent. It goes to the assistant, and main wakes on the assistant's answer.
- A woken agent first catches up on what it has not seen, then acts.
- Waking and speaking are two decisions. A woken agent may read, remember and act with its tools, and end its turn without saying anything in the chat.

## Wake gate

The check that decides whether a message wakes the agent. It looks at where the message was said and who said it, never at the text, and answers *wake*, *quiet*, *block* or *review*. On *review*, the sentinel reads the message and ignores it, answers it itself, or wakes the agent.

- By default a chat switched off wakes nobody, a policy that blocks the sender or the chat wins over every setting, a sender below the bond levels the agent replies to stays quiet, and a trusted sender or one a policy allows wakes the agent. Anyone else goes to review.
- A chat that wakes the agent only on a mention stays quiet on a message addressed to nobody. Another bot's message stays quiet unless the chat takes bots' messages, or takes them when they mention the account and this one does. A message that mentions only others stays quiet unless the chat answers those. A rule a kind of connection does not offer runs at the value the kind fixes, else at its default ([Chat rule](chats.md#chat-rule)).
- Another bot's message never stops a turn.
- A message that wakes nobody shows no typing, and stays in the record: a message the reply rule, the bot rule or a mention of others keeps quiet is recorded like any other. A chat switched off is not heard at all, and none of its messages are recorded.
- An agent whose own app runs its turns has no wake gate. On an account linked to it, every message reaches the app, and the app decides what wakes the agent. Only first-party apps may run their agents' turns.
- When two of Rome's accounts hear a message, the wake is decided once for each of them, on that account's settings and on how the message addressed it. A message addressed to neither can wake both agents, if both chats wake on every message.
- The wake gate calls no model, sends nothing and stores nothing, so the same message from the same sender always gets the same answer. It reads the guardian's settings as they are when the message arrives.

## Addressed

Whom a message addresses, as one of Rome's accounts reads it: Rome's account, others, or nobody. It is worked out from the [message](connections.md#message) a connection delivered, for each of Rome's accounts that received it, and it is never stored on the message.

- A message addresses Rome's account when it is a direct message, mentions the account, replies to a message the account said, or is said in a thread the account started.
- Otherwise a message that mentions or replies to someone else addresses others, and any other message addresses nobody.
- A reply to Rome's account that also mentions someone else addresses Rome's account (Ouou, 2026-11-20). So does a message in a thread the account started that mentions someone else, by the same rule.
- Two of Rome's accounts in one chat can read one message differently: it can address one and not the other.
- Until the wake is decided for each account from the connection's message (ZHA-229), the wake gate reads addressing from the fields apps pass on. Those carry no reply to someone else, so the gate reads such a reply as addressing nobody.

## Projection

The agent's working memory of a chat: a view built from the chat's messages, not the record itself. [Chats](chats.md) keeps the record and offers it. What the agent keeps of it is its own business ([Agents](agents.md)).

- There is one default view and no setting. When the agent wakes, it reads the recent messages of the place the waking message was said in: the chat itself, or the thread, which starts with the message it was opened from when there is one. A message alone rarely carries the whole context, in a group or in a direct message.
- In the open chat the view is the open chat's messages, where each thread shows as the message it was opened from. Messages said in threads are not mixed in, and a thread opened from no message of the chat is not in this view. The agent reaches it by reading the chat's other threads.
- Whoever writes chooses the place. Mentioning the agent in a thread hands it a task with the thread as its context. Asking in the open chat gives it the chat around the question.
- How far back "recent" reaches is the agent's own bound.
- A session that opens in a direct message on a connection first reads the chat's latest messages from where the chat lives, so its first turn knows what was said before it opened, whether or not Rome holds a copy. A group reads none, because the platform also holds what was said there before Rome joined, and neither does a personal account's chat, such as WhatsApp's, for the same reason: the read is only from a platform that answers it live, such as Rome's own Slack app. A chat whose channel hands the agent every message, such as the dashboard's, needs none. A read that fails or takes too long opens the session without them, and the agent reads further back on its own.
- Every message a wake hands the agent names who said it: the message that woke it, the messages it catches up on, and the message it answers. Each carries the name the message showed and, apart from it, People's answer to [who is this](people.md#who-is-this): a person with their bond level, or nobody. A message from an account with a [delegate link](people.md#delegate-link) says it is an agent acting for that person.
- A message a person writes in a [Concierge chat](chats.md#concierge-chat) carries the name of who wrote it the same way: the guardian's name, or the email a dashboard admin signed in with. It carries no answer of People's, who knows no dashboard sign-in.
- An app that hears the messages of people [let in](#entry) gets the same answer with each message, so an app running its own agent names a sender as Rome's own turns do.
- Participation asks People when the turn runs and never keeps the answer on the message, so a link the guardian makes or removes shows from the next turn. It never takes a person from the name a message showed, and no name a sender picks can pass for People's answer.
- A message's text is what a person sees on the platform, whichever of Rome's accounts heard it. On Discord every mention shows as `@name`, the agent's own account included. Whether the message addressed the agent's account is a fact the connection reports beside the text, not something read from it.
- A woken agent is told the name of the account it speaks as in the chat, so it can tell its own mention from another of Rome's accounts.
- The messages the agent reads further back on its own, and those a renewed session carries over, show only the name each message showed.
- Beyond the default view, the agent can read more of the chat on its own judgement: further back, the chat around a thread, other threads in the chat.

## Reply

What the agent says back after a wake, through the account it was woken on.

- The agent decides where in the chat a reply goes: the thread the message was said in, the chat itself, or another of its threads.
- A reply stays in the chat the agent was woken in. A message to any other chat pauses on an approval card for the guardian and leaves only once they allow it. A message from one of the guardian's dashboard chats into another needs no card: the guardian is the only other participant in both, so nothing leaves their sight. Concierge hands work to its task chats this way.
- A reply is a message like any other, said by the agent as its own account or on the guardian's behalf under theirs, as the kind of link says.

## Send gate

The check that decides whether a message an agent wrote may go out. It looks at where the message goes, who sent the message it answers and which agent wrote it, never at the text, and answers *send*, *check*, *ask the guardian* or *refuse*. On *check*, a checking agent reads the message and sends it, refuses it, or holds it for the guardian in Approvals.

- A reply to the guardian goes out unchecked, even in a group where others read it, and a reply to anyone else is checked first.
- The send gate calls no model, sends nothing and stores nothing, so the same request always gets the same answer.
- The sentinel's own reply to a message it triaged does not pass the send gate.
- An agent whose own app runs its turns has no send gate: its app decides what goes out.

## Audience

Who can read what a turn says: *private* (only the guardian) or *shared* (anyone else may). It is read off the turn's place and the sender when the turn starts, and it does not change during the turn.

- A turn is private in a dashboard chat only the guardian can open, and in a direct message with Rome's account that the guardian sent while nobody but the guardian may open the dashboard, where Rome records that chat. The guardian's Concierge chats and its task chats open only for the guardian. Any other dashboard chat opens for every dashboard user, so it is private only while nobody but the guardian may open the dashboard. A group, a channel, an email thread, a direct message from anyone else and a visitor's chat are shared.
- A turn whose place is unknown is shared. A turn with no place of its own, such as a summoned agent's, takes the audience of the turn that started it, and is shared when no turn did.
- A subagent, fork or task takes its starter's audience, never a more private one. A turn an action starts, such as a summon or the reply to a channel message, takes the audience Rome read for the chat that ran the action, and is shared when Rome read none. A routine's fire takes the audience of the chat it works for, and a routine of no chat is shared.
- [Personal-data](../concepts/data.md#personal-data) actions run only in private turns. In a shared turn they are refused with a reason the agent can pass on. A routine that reads personal data is refused when it is made for a shared chat.
- A shared turn reads only the chat it is in: its own chat, or, in a native thread, the chat the thread hangs off. An app's read of any other chat is refused. An agent's turn with no chat of its own, such as a summoned agent's, reads any chat when it is private, and no chat when it is shared. A private turn reads any chat, and so does an action outside any agent's turn. A routine's fire runs outside one, so a routine made for a shared chat still reads any chat, a known gap.
- An agent's shell reads the audience too, and the `rome-node` CLI refuses a device's personal capability in a shared turn. That is a guardrail against a model mistake, not a boundary: the agent can unset it. A summoned agent's shell reads as shared even when its turns read as private, the safe side.

## Decided against

- **A projection setting per agent or per chat.** One default serves every chat: the place the waking message was said in. A setting would move a reading decision that belongs to the agent into chat configuration.
- **A thread as the boundary of the agent's memory.** What the agent remembers is its own decision, in Agents. Participation says only what it is offered at a wake.
- **Refusing every message outside the woken chat.** The guardian sometimes wants the agent to carry something across chats. An approval card keeps that possible and keeps the guardian in the loop.
- **Hiding personal-data actions in shared turns.** A hidden action leaves the agent unable to say why it cannot answer. A refusal with a reason lets it point the guardian to a private chat.
