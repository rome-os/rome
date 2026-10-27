# Chats

Who said what, where, and as whom. Chats follows the definitions in [Connections](connections.md) and [Agents](agents.md) and changes neither. What happens when an agent is woken by a chat is in [Participation](participation.md).

## Chat

A place where people and agents talk: a group, a direct message, the chat built into the dashboard. The code and the dashboard call it a conversation, a deprecated alias for the same thing.

- A group is named by the platform's own id for it, so one group is one chat however many of Rome's accounts are in it.
- A direct message is named by its two ends, the other account and the one of Rome's accounts it writes to, so a colleague writing to Sales and to Support is two chats, whatever id the platform gives the two.
- A chat starts existing in Rome when its first message reaches Rome through one of Rome's accounts. A chat with an [assistant](#assistant) is the exception: it starts when Rome first knows the assistant, before any message.
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

## Assistant

An agent outside Rome, such as a Dot, Muse or another Rome, that talks to Rome through Rome Cloud. It is a participant with an account on Rome Cloud, not one of Rome's agents.

- Two assistants are the same assistant when Rome Cloud gives them the same id. A renamed assistant is the same assistant.
- An assistant has a kind, such as Dot, Muse or Rome, and the product shows it beside the name.
- An assistant and Rome talk in one direct message, so each assistant is one chat. It starts when Rome first knows the assistant, so the guardian can write first.
- Rome speaks in that chat through its own account on Rome Cloud. Main speaks for Rome there, since the account takes no other agent.
- What the guardian writes in an assistant's chat goes to the assistant, said by the guardian through Rome's account. Main does not answer it.
- The dashboard shows assistants' chats on one Assistants page, one chat at a time: it opens on the chat that moved last, and its header switches to another assistant, each marked with its kind. The page stays off the sidebar until the guardian adds it. Assistants' chats are not in the dashboard's chat list.
- Another Rome is an assistant, but the dashboard does not list it. Rome can still message it, and its messages still reach Rome.

## Reply rule

A setting on a chat, for each of Rome's accounts in it, saying when that account's agent is woken: on every message, only when mentioned, or when it is needed. The same account can be chatty in one group and quiet in another.

- It decides when the agent is woken, nothing more. What reaches the chat is whatever the platform delivers, and how much of it the agent reads when woken is the agent's own business ([Agents](agents.md)).
- "When it is needed" hands the decision to a lightweight check. A mention always wakes the agent under it. What a wake is and what follows it is in [Participation](participation.md#wake).
- For a delegate on the guardian's own account, the current behaviour stays as it is.
- A chat with an assistant has one reply rule, every message, and the guardian cannot change it.

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

Somewhere chats live: Feishu, Lark, Discord, Telegram, email, Rome's own dashboard, Rome Cloud.

- Two platforms are the same when one account can log in to both. Feishu and Lark are different platforms. A Telegram bot and a signed-in Telegram user are one platform.
- An agent may have any number of own accounts on one platform.

## Account

A participant's identity on a platform. A colleague's Feishu identity is an account. What Feishu calls a bot is an account too: the one created for the sales agent is the sales agent's identity on Feishu. These docs say account, not bot.

- Two accounts are the same account when the platform and the platform's own id are the same.
- The platform's own id is the one the platform uses for that account everywhere, so the same person is seen with the same id by every one of Rome's accounts on that platform. On Feishu that is the tenant-wide user id, not the per-app one.
- A person's identity and an agent's identity on a platform are the same kind of thing.
- Most accounts in a chat are other people's. Rome has no connection to them and no agent speaks through them.
- An account Rome holds a connection to has at most one agent speaking through it, held by its [connected account](#connected-account), in every chat and DM that account is in: an own-account link if the account is the agent's own, a delegate if it is the guardian's. There is no per-chat choice of agent.
- A connected account may have no agent: the guardian gave Rome access to it but is not using envoy on it. Rome then does not listen to that account's messages at all. No chat forms through it and nothing is recorded, until an agent is linked.
- Those link rules cover accounts that take an agent. An account that takes none, such as email or WhatsApp, is always listened to.
- The guardian **links** an agent to the account, **switches** it in one step, or **unlinks** it. The noun is the account's agent.
- Connecting an account and linking an agent are two separate operations, never one. So every connected account passes through the state of being connected with no agent, however briefly, and Rome never picks an agent for it on its own. Where the product asks the guardian to pick one, before or after connecting, is a matter of design, not of the model.
- An account named "Sales agent" is the sales agent, wherever it appears. That is the intuition the rules protect.

## Connected account

One of Rome's accounts as Chats sees it: a [connection](connections.md#connection) that lets Rome chat, with the agent that speaks through it.

- A connected account has the identity of its connection and no other. Its one attribute is its agent.
- It starts when its connection is connected, with no agent, and ends when the connection is disconnected, for every kind of connection. Connecting the same account again makes a new connected account, with no agent.
- The account it stands for is the one its connection's grant names. One connection reaches an account at a time, so one connected account stands for it at a time.
- The guardian links, switches and unlinks its agent on the connected account, naming it by its connection. The dashboard shows it by its account's platform, id and name.
- A message or a participant names an account by platform and the platform's own id, never by a connection. A message remembers who said it, not the connection that carried it. Rome finds the connection when it sends, as the one whose grant reaches the account.
- Its kind of link, [own account](#own-account) or [delegate](#delegate), follows from its kind of connection: a bot is always the agent's own account, and the guardian's signed-in account always takes a delegate.

## Account profile

What a platform says about an [account](#account): its display name, handle and avatar. Chats keeps it as a cache, not a record of its own.

- It is keyed by the account, the platform and the platform's own id, and has no identity of its own. Nothing points at it: a reader that holds an account looks its profile up by the same value.
- The channels fill it as they learn: from an address book's sync, and from what a sender put on a message. On a platform Rome mirrors an address book for, only the address book fills it, keyed by the book's own id for the account, since a message may name the sender by another of the account's addresses. Elsewhere, what a platform's address book holds would outrank what a sender called themselves, so a message never overwrites a profile an address book wrote.
- It can be dropped and rebuilt from the platforms at any time, and nothing else is lost when it is. An account no profile has been learned for yet is still an account.
- A channel's own mirror of an address book stays the source for what it mirrors. A name is read from the mirror first, then from the profile.

## Envoy

The feature's name: linking agents to accounts so they can take part in chats on platforms. Not a thing in the model. The things are the two kinds of link below. The dashboard's use of the name as a page title is branding.

## Own account

One kind of link: an agent linked to an account that is the agent's own, so the agent speaks as that account.

## Delegate

The other kind of link: an agent linked to the guardian's own account, so it answers on their behalf. The guardian picks the delegate. Main is suggested.

- Own account and delegate are different kinds of link, and the product shows which one an account has. The kind of connection decides which, and the guardian never picks it.
- When the guardian switches the agent on an account, the new agent picks up where the old one left off: the chat's history is there for it to read. What it remembers is its own business.

## Decided against

- **Channel as a thing the guardian meets, with its own identity and lifetime.** A channel is one to one with a connected account, so the two words name one thing and the guardian only ever sees the account. Its jobs went to account, connection, connected account and chat. The code's channel layer ([Channels](../architecture/channels.md)) is retired as those words replace it.
- **The agent as part of the connection.** Which agent speaks through an account is the guardian's decision about a chat identity, so it belongs to Chats. Kept on the connection, Connections would hold a fact only Chats uses.
- **A record of Rome's account kept by its platform and id rather than by its connection.** It would outlive the connection and survive a reconnect, so a new connection would inherit an agent the guardian never set on it. A connection whose grant has not yet reported its account would have no record to hold an agent.
- **Linking an agent by the account's platform and id.** A dashboard tab left open across a disconnect and a reconnect would link an agent to a connection the guardian never looked at. The connection's identity changes on reconnect, so a stale command is refused.
- **Storing the kind of link.** It follows from the kind of connection, and a stored copy could disagree with it. It becomes the guardian's choice only if a kind of connection ever allows both.
- **A per-chat choice of agent that overrides the account's agent.** An account named "Sales agent" has to be the sales agent wherever it appears, and a per-chat override breaks that intuition.
- **At most one account per agent per platform.** A guardian with two Feishu accounts for one agent is an ordinary case, and the rule forced a "move the link" behaviour nobody asked for.
- **Linking the first account of a kind of connection to main automatically.** Connecting and linking are two operations and cannot be made one, so a state with no agent exists anyway, and an agent the guardian did not pick is confusing.
- **A thread as a chat of its own.** People do not think of a thread as a chat. It is a side conversation inside one, seen by everyone in it. Letting the thread model decide the agent's memory boundary went with it. Memory is the agent's own decision.
- **"Bot" and "linked agent" as names.** A person's identity and an agent's identity on a platform are the same kind of thing, and one name per thing is the writing rule. Unlink stays: it is the verb for taking an agent off an account.
- **"Conversation" as the canonical word.** The guardian says chat. Conversation is kept as an alias until the rename lands.
- **"Agent" for a Dot or Muse.** Agent means one of Rome's own agents, which the guardian defines and runs. A Dot or Muse runs elsewhere and answers to someone else's rules, so one word for both would need context to tell them apart.
- **Assistants' chats mixed into the dashboard's own chats.** The guardian talks to Rome in one and watches Rome talk to another agent in the other. Mixed together, a chat with Muse reads as a chat with Rome.
- **The guardian's line in an assistant's chat going to main.** It would put two conversations in one place: the guardian with main, and Rome with the assistant. Talking about an assistant with main belongs in the dashboard's own chat.
- **A reply rule the guardian sets per assistant.** An assistant writes to Rome to get an answer, and no case has come up yet where one should be ignored. The setting waits until one does.
- **An assistant's chat starting at its first message.** The guardian could not find an assistant to write to before it had written, so they could never start the chat.
- **Listing other Romes among the assistants, for now.** Talking to another Rome has no product of its own yet: no way in, and no rule for two Romes answering each other's replies. Every Rome in the account, stopped test stacks included, would also fill the list. Other Romes return to the list when that product is designed.
- **Assistants' chats as a group in the dashboard's chat list.** Main answers assistants, so the guardian reads their chats now and then rather than watching them. A group beside the guardian's own chats kept them in view all the time.
- **An account record with an id of its own that links and profiles point at.** It would make the account an entity with an identity Rome minted, which no platform has, and Rome never makes an account, so a link to one Rome has not heard from yet would have nothing to point at. The [account profile](#account-profile) keyed by the account gives what the platform says a home without giving the account a lifetime.
