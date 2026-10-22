# Chats

Who said what, where, and as whom. Chats follows the definitions in [Connections](connections.md) and [Agents](agents.md) and changes neither. What happens when an agent is woken by a chat is in [Participation](participation.md).

## Chat

A place where people and agents talk: a group, a direct message, the chat built into the dashboard. The code and the dashboard call it a conversation, a deprecated alias for the same thing.

- A group is named by the platform's own id for it, so one group is one chat however many of Rome's accounts are in it.
- A direct message is named by its two ends, the other account and the one of Rome's accounts it writes to, so a colleague writing to Sales and to Support is two chats, whatever id the platform gives the two.
- A chat starts existing in Rome when its first message reaches Rome through one of Rome's accounts.
- A chat's history belongs to the chat. It goes when the last of Rome's accounts leaves the chat, not before.
- A chat may have threads inside it.

## Thread

A chat inside a chat, usually started from one of its messages. A thread is not a chat of its own: it lives in one and is seen from it.

- A thread is known by its chat and the platform's own id for it. The message it was opened from is kept when there is one. A private thread may have none in the chat.
- A thread starts existing in Rome when the first message said in it reaches Rome. Opening it from a message does not move that message: it stays a message of the open chat.
- A thread belongs to the chat it was started in. The message it was opened from, when there is one, is its first, and every message said in it is a message of the chat, marked as said in that thread.
- A thread has its own participants: those the platform lists in it, and writing in it makes you one.
- Everyone in the chat whom the platform lets see a thread sees it: who is in it and what is said. An agent in the chat sees its threads the same way, and can write in them. A thread the platform hides from some members, such as a private thread, is hidden from them in Rome too.
- The chat's reply rule applies in its threads. A thread has no reply rule of its own.
- A thread goes with its chat.

## Participant

Someone in a chat: a person or an agent.

- The participants of a chat are everyone the platform says is a member of it.

## Agent

One of Rome's agents, such as main, sales or support, taking part in a chat. What an agent is belongs to [Agents](agents.md). Here it is a participant.

- When an agent speaks through its own account, the agent is the participant.
- When an agent answers from the guardian's account, the guardian is the participant and the agent answers on their behalf.
- An agent sees every message its account receives on the platform: whatever the platform delivers to that account, mentioned or not.
- When the agent is woken by what it sees is the chat's reply rule for that account.
- How an agent remembers what it sees, in a chat or in its threads, is the agent's own decision and belongs to Agents. Chats describes participants and messages and says nothing about memory.

## Reply rule

A setting on a chat, for each of Rome's accounts in it, saying when that account's agent is woken: on every message, only when mentioned, or when it is needed. The same account can be chatty in one group and quiet in another.

- It decides when the agent is woken, nothing more. What reaches the chat is whatever the platform delivers, and how much of it the agent reads when woken is the agent's own business ([Agents](agents.md)).
- "When it is needed" hands the decision to a lightweight check. A mention always wakes the agent under it. What a wake is and what follows it is in [Participation](participation.md#wake).
- For a delegate on the guardian's own account, the current behaviour stays as it is.

## Message

One thing a participant said or did in a chat.

- Every message goes one way: to Rome or from Rome.
- A message is made of text, attachments and [widgets](#widget).
- Every message reads as plain text, so any person on any platform, and any agent, can follow the chat. A widget brings its own plain-text line.
- Acting on a widget is a message of its own, from whoever did it, in the place the widget is in. It says what they meant, such as answering Q3, approving or picking a place, not how they did it: a button on one platform may be a typed reply on another. Without it, someone reading the chat later could not tell what was chosen.
- A delegate's reply is recorded as said by the agent on the guardian's behalf, under the guardian's account.

## Widget

Something shown in a chat that people can look at or act on: a question with choices, an approval request, a map from an app.

- Widgets come from one shared catalog. Each kind has a name, what it holds, what people can do with it (answer, approve or deny, pick), and how each of those reads as plain text. Rome's own question and approval are kinds in it, beside the kinds apps add.
- Each platform draws the kinds it can as its own cards, and sends the plain-text line for the rest. Feishu draws a question as a card. Email sends it as text.
- A widget's live state belongs to what it is about. An approval request shows as approved because the approval is.
- An agent shows a widget by calling a tool.

## Platform

Somewhere chats live: Feishu, Lark, Discord, Telegram, email, Rome's own dashboard.

- Two platforms are the same when one account can log in to both. Feishu and Lark are different platforms. A Telegram bot and a signed-in Telegram user are one platform.
- An agent may have any number of own accounts on one platform.

## Account

A participant's identity on a platform. A colleague's Feishu identity is an account. What Feishu calls a bot is an account too: the one created for the sales agent is the sales agent's identity on Feishu. These docs say account, not bot.

- Two accounts are the same account when the platform and the platform's own id are the same.
- The platform's own id is the one the platform uses for that account everywhere, so the same person is seen with the same id by every one of Rome's accounts on that platform. On Feishu that is the tenant-wide user id, not the per-app one.
- A person's identity and an agent's identity on a platform are the same kind of thing.
- Most accounts in a chat are other people's. Rome has no connection to them and no agent speaks through them.
- An account Rome holds a connection to has at most one agent speaking through it, in every chat and DM that account is in: an own-account link if the account is the agent's own, a delegate if it is the guardian's. There is no per-chat choice of agent.
- A connected account may have no agent: the guardian gave Rome access to it but is not using envoy on it. Rome then does not listen to that account's messages at all. No chat forms through it and nothing is recorded, until an agent is linked.
- Those link rules cover accounts that take an agent. An account that takes none, such as email or WhatsApp, is always listened to and keeps its current contracts.
- The guardian **links** an agent to the account, **switches** it in one step, or **unlinks** it. The noun is the account's agent.
- Connecting an account and linking an agent are two separate operations, never one. So every connected account passes through the state of being connected with no agent, however briefly, and Rome never picks an agent for it on its own. Where the product asks the guardian to pick one, before or after connecting, is a matter of design, not of the model.
- An account named "Sales agent" is the sales agent, wherever it appears. That is the intuition the rules protect.

## Envoy

The feature's name: linking agents to accounts so they can take part in chats on platforms. Not a thing in the model. The things are the two kinds of link below. The dashboard's use of the name as a page title is branding.

## Own account

One kind of link: an agent linked to an account that is the agent's own, so the agent speaks as that account.

## Delegate

The other kind of link: an agent linked to the guardian's own account, so it answers on their behalf. The guardian picks the delegate. Main is suggested.

- Own account and delegate are different kinds of link, and the product shows which one an account has.
- When the guardian switches the agent on an account, the new agent picks up where the old one left off: the chat's history is there for it to read. What it remembers is its own business.

## Decided against

- **Channel as a thing the guardian meets, with its own identity and lifetime.** A channel is one to one with a connected account, so the two words name one thing and the guardian only ever sees the account. Its jobs went to account, connection and chat. In code, channel stays as the name of the layer that carries an account's messages ([Channels](../architecture/channels.md)), a technical word like repository.
- **A per-chat choice of agent that overrides the account's agent.** An account named "Sales agent" has to be the sales agent wherever it appears, and a per-chat override breaks that intuition.
- **At most one account per agent per platform.** A guardian with two Feishu accounts for one agent is an ordinary case, and the rule forced a "move the link" behaviour nobody asked for.
- **Linking the first account of a kind of connection to main automatically.** Connecting and linking are two operations and cannot be made one, so a state with no agent exists anyway, and an agent the guardian did not pick is confusing.
- **A thread as a chat of its own.** People do not think of a thread as a chat. It is a side conversation inside one, seen by everyone in it. Letting the thread model decide the agent's memory boundary went with it. Memory is the agent's own decision.
- **"Bot" and "linked agent" as names.** A person's identity and an agent's identity on a platform are the same kind of thing, and one name per thing is the writing rule. Unlink stays: it is the verb for taking an agent off an account.
- **"Conversation" as the canonical word.** The guardian says chat. Conversation is kept as an alias until the rename lands.
