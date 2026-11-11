# Chats

Who said what, where, and as whom. Chats follows the definitions in [Connections](connections.md) and [Agents](agents.md) and changes neither. What happens when an agent is woken by a chat is in [Participation](participation.md).

## Chat

A place where people and agents talk: a group, a direct message, the chat built into the dashboard. The code and the dashboard call it a conversation, a deprecated alias for the same thing.

- A chat is known by its platform and the platform's own id for it. Whether it is a group or a direct message is something about the chat, not part of what it is known by.
- A group is named by the platform's own id for it, so one group is one chat however many of Rome's accounts are in it.
- A direct message is named by its two ends, the other account and the one of Rome's accounts it writes to, so a colleague writing to Sales and to Support is two chats, whatever id the platform gives the two. Where the platform gives a direct message no id of its own across Rome's accounts, Rome derives one from the two ends.
- A chat starts existing in Rome when its first message reaches Rome through one of Rome's accounts. A chat with an [assistant](#assistant) is the exception: it starts when Rome first knows the assistant, before any message.
- A chat's history belongs to the chat. It goes when the last of Rome's accounts leaves the chat, not before.
- A chat may have threads inside it.
- In the dashboard, a chat is a [common chat](#common-chat), a [fork chat](#fork-chat), a [Concierge chat](#concierge-chat) or a [task chat](#task-chat). The dashboard says chat for every one of them.

## Thread

A chat inside a chat, usually started from one of its messages. A thread is not a chat of its own: it lives in one and is seen from it.

- A thread is known by its chat and the platform's own id for it. The message it was opened from is kept when there is one. A private thread may have none in the chat.
- A thread starts existing in Rome when the first message said in it reaches Rome. Opening it from a message does not move that message: it stays a message of the open chat.
- A thread belongs to the chat it was started in. The message it was opened from, when there is one, is its first, and every message said in it is a message of the chat, marked as said in that thread.
- A thread has its own participants: those the platform lists in it, and writing in it makes you one.
- Everyone in the chat whom the platform lets see a thread sees it: who is in it and what is said. An agent in the chat sees its threads the same way, and can write in them. A thread the platform hides from some members, such as a private thread, is hidden from them in Rome too.
- The chat's reply rule applies in its threads. A thread has no reply rule of its own.
- A thread goes with its chat.

## Chat thread

One line of conversation inside a [Concierge chat](#concierge-chat) that its owner follows on its own. Unlike a [thread](#thread), it is not a place: its messages stay in the chat's own timeline. A chat thread exists only on demand, and the Concierge never places a message.

- A chat thread is known by its chat and the id of its first message, its root.
- An owner's message sent as a reply, or from the thread view, is in that thread at once, and nothing moves it.
- A task has one root, kept for good. A task started for an owner's message has that message's thread, or that message as its root. The Concierge's messages in that turn that answer the message join the thread with it. A task no one owner's message started takes the first owner's message sent on to it, or the first thing it brings back.
- Whatever a task brings back later, its result, its question card or a forward, joins the task's thread. So does an owner's message sent on to it, which keeps a follow-up in the task's story.
- A Concierge message that names what it is about goes there, whatever turn says it: a task's result or news joins that task's thread, and a message naming a thread, or the owner's message it answers, goes where that is. Only a message that names nothing goes by its turn: into the thread of the task the turn reports on, or of the turn's one owner's message.
- A turn about two things, the owner's message and another task's news that a newer message took over, is mixed. There a message that names nothing goes in no thread, and is never guessed into the owner's.
- A task's row points to the owner's message the task is for, before anything said in the same turn, which may be another task's report.
- A task moved to another Concierge chat leaves its thread behind, and starts a new one there the same way.
- Any other message is in no chat thread: an owner's message typed in the chat, and the Concierge's answer to one. The Concierge's answer to a message in a thread is in that thread.
- A message in no chat thread opens a thread view that shows it alone.
- Only a thread's label, or the quote in a reply's bubble, opens the thread view. Reply on a message opens the reply bar alone, and the reply still goes into that message's thread. Reply inside an open thread view keeps it open. Closing the reply bar, or sending, closes an open view with it.
- The chat's timeline shows every message in the order it was said, whatever its thread. The thread view shows one thread's messages on their own.
- In the chat's timeline, every Concierge message in a chat thread shows a label under it that names the thread and opens it: the task's title for a task's thread, else the start of its first message. The owner's own messages show none, and neither does the thread view. A label shows no count.

## Place

Where a message is said, and where a send goes: a chat, or a thread in a chat.

- Two places are the same when they name the same chat and the same thread, or both name no thread.
- Rome sends to a place, never to an account. Messaging a person on one of their accounts is sending into the direct message that reaches that account.
- A send into a place goes out from one of Rome's accounts in it: the one the send names, or the only one Rome holds on the platform. With several and none named, the send is refused rather than sent from an account nobody chose.
- On the dashboard each of Rome's agents has its own account, so a send into a dashboard chat names the agent it is from. Rome is the dashboard's platform, so the message is said once it is recorded, and the chat's agent is woken by it as by the guardian's.

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

## Common chat

A dashboard chat a person starts themselves, in a project. The dashboard calls it a chat.

- A person **starts** one from the Projects section of the [chat list](#chat-list), from the search palette, or from an app or a project. It exists from its first message.
- It belongs to one project, or to one folder on a device, and the chat list groups it there.
- Its owner can **rename**, **archive** and **delete** it.
- A settled turn of it can be **forked** into a [fork chat](#fork-chat).

## Fork chat

A chat forked from one turn of another chat, carrying that chat's history up to the turn.

- A person **forks** one from a settled turn of a common chat or of a fork chat. A main chat, a topic chat and a task chat offer no fork.
- A chat forked from a Concierge chat still talks to the Concierge, so it is a topic chat, not a fork chat: it sits under the main chat and offers no fork. A chat forked from a common chat or a fork chat is a fork chat, under Projects.
- It is a chat of its own once forked: what is said in it does not reach the chat it came from.
- It keeps the folder of the chat it was forked from, and the model it was forked with.

## Status reaction

A mark Rome puts on its owner's message in a [Concierge chat](#concierge-chat) to show how the work it asked for stands: working, or failed. Work that finished shows none, since the reply says so. It takes the place of an acknowledgement from the Concierge.

- Rome sets it, never the Concierge. A message has at most one, and a newer state replaces the older one.
- A message gets one as soon as a Concierge turn takes it in: working, before the Concierge says or starts anything. Each message a turn takes gets its own.
- The message's work is that turn and every task the Concierge starts for it or passes its words on to. The mark stays working while any of them works, and goes away once all are done. It turns failed only when one fails, and a failed mark stays, since a crash may leave no reply. A task that asks its owner a question is still working.
- How the turn's end sets the reaction:
  - It completes: done, which shows no mark once its tasks are done too.
  - It fails with an error, or ends with no end of its own, as when the process dies: failed.
  - Its owner stops it: stopped, which counts toward no reaction.
  - A newer input supersedes it and the work carries into the next turn: still working, until that turn ends.
- A task that ends keeps the message working until the Concierge says its result: until the turn that reports the task ends, or a turn that says the result naming the task ends. Only then does it settle as the task ended. Until then the reply has not told the owner anything. A report that never comes shows failed.
- How a task's end sets the reaction, the same way:
  - It finishes, or the Concierge marks it done: done, which shows no mark.
  - It fails with an error, or its turn ends with no end of its own, as when the process dies: failed.
  - Its owner stops it, or the Concierge drops it: stopped. A stopped task counts toward no reaction, so a message whose only task was stopped has none, and the mark goes away.
  - A newer input supersedes its turn and the work carries into the next turn: still working, until that turn ends.
- A stopped task that is resumed or given more words is working again.
- A message counts only the work not stopped: working while any of it works, then failed if any failed, else none. When all of it was stopped, it has none too.
- A message the Concierge answers in the same turn, with no task, is working while that turn runs, and the mark goes away when the turn completes.
- It is not a message. It never reaches the phone as a push, and it does nothing when pressed.
- A common chat has none, and neither does a task chat.

## Concierge chat

A dashboard chat where its owner talks with their Concierge: a [main chat](#main-chat) or a [topic chat](#topic-chat). Every Concierge chat of one owner talks to the same Concierge, with one list of follows and one list of tasks. Memory is one for every owner.

- A Concierge chat is a chat of its own, not a thread. What is said in one does not show in another, and each has its own agent session.
- The Concierge reads another Concierge chat of the same owner when the question needs it, and not on every turn. What it keeps across chats is what it writes to memory, follows and tasks.
- While the Concierge is on, the guardian and every visitor on the dashboard allow-list each have their own Concierge. App users have none.
- A Concierge chat is private to its owner: to anyone else, the guardian included, it does not exist. So is a fork or a subagent session of it, or of a task chat it started, from the moment it is made.
- Its follows and unfinished tasks go to its owner's main chat when it is archived or deleted, and everything that reported to it stays its owner's.
- A visitor dropped from the dashboard allow-list keeps their Concierge chats and follows, but their Concierge tells them nothing until they are back on the list.
- Each follow sends its alerts to one Concierge chat: the one it was followed from, until its owner **moves** it to another. One owner follows one thing once, whatever chat asks for it. Two owners may follow the same thing, and each hears it.
- Digest times, quiet hours and the time zone they are read in are each owner's own.
- A Concierge chat can start [task chats](#task-chat), and each task's result comes back to the Concierge chat that started it. A Concierge chat's task panel lists only its own tasks: the main chat's lists the tasks whose chat is the main chat.

## Main chat

The one Concierge chat each owner always has.

- The main chat exists while the Concierge is on, and it is never archived or deleted. The dashboard offers neither.
- The dashboard's Chat entry and its home page open the main chat. When it cannot be loaded, the dashboard says so rather than opening a blank chat.
- The dashboard opens it at `/message`, for the guardian and for each visitor alike. A topic chat is at `/chat/<id>`. The old `/chat/concierge` address redirects to `/message`.
- The digest goes to the main chat and lists every Concierge chat's items, grouped by chat.
- Alerts and tasks whose Concierge chat is archived or deleted come here.
- In the header of every Concierge chat, a topic chat's included, and in the Concierge's own copy, the dashboard calls the Concierge by the name the guardian gave their agent (else "Rome", as the main agent). A topic chat's own name shows in the chat list. The main chat is stored as "Main chat", and the chat list labels it "Main chat" in the dashboard's language. Product copy never names it "Concierge".

## Topic chat

A Concierge chat its owner starts for one topic, such as the calendar or a project. It stands beside the main chat, not under it.

- A topic chat starts when its owner **starts** one, from the dashboard or by asking the Concierge. The Concierge never starts one on its own. It starts on the model the main chat uses.
- One started from the dashboard opens blank, like a new chat, and exists from its first message, which names it. One the Concierge starts with a name keeps it, and the main chat's name never changes on its own.
- Its owner can **rename**, **archive** and **delete** it. Archiving or deleting it moves its follows and tasks to its owner's main chat, and the Concierge says so there.
- An owner may have any number of topic chats.

## Task chat

A chat the Concierge starts to hand one piece of work to another agent. It belongs to the Concierge chat that started it, and its result comes back there.

- A task chat has a row in its owner's task list. It is private to the owner of the Concierge chat that started it, who alone can open it and write in it.
- A task chat carries one piece of work. It gets no alerts and no digest.
- A task chat is in the [chat list](#chat-list), under its project with the common chats, with a mark saying the Concierge started it. It also opens from its row in the task list and from its task card, and search finds it.

## Chat list

The dashboard's list of a person's chats, beside the rail. Every dashboard person gets the same list, with their own main chat in it.

- It opens with the main chat, labelled "Main chat", and the topic chats under it, latest first: five, then a More row for the rest. The plus beside the main chat starts a topic chat.
- Below a divider, the Projects section holds the common chats, fork chats and task chats, grouped by project or by device folder, with the default project first. The default project's row is always there, under every filter, even when it holds no chat. A plus on a project row starts a chat in that project, and the composer can still move it to another project before its first message. The plus shows on hover, and always on a touch screen.
- Nothing in it is pinned, and it is not grouped by date.
- Its status filter, active, archived or all, applies to every chat in it. Under archived the main chat is hidden, since it is never archived, and an archived topic chat stays under the main chat, not in Projects.

## Reply rule

A setting on a chat, for each of Rome's accounts in it, saying when that account's agent is woken: on every message, only when mentioned, or when it is needed. The same account can be chatty in one group and quiet in another.

- It decides when the agent is woken, nothing more. What reaches the chat is whatever the platform delivers, and how much of it the agent reads when woken is the agent's own business ([Agents](agents.md)).
- "When it is needed" hands the decision to a lightweight check. A mention always wakes the agent under it. What a wake is and what follows it is in [Participation](participation.md#wake).
- For a delegate on the guardian's own account, the current behaviour stays as it is.
- A chat with an assistant has one reply rule, every message, and the guardian cannot change it.

## Message

One thing a participant said or did in a chat.

- Every message goes one way: to Rome or from Rome.
- A message that reaches Rome is recorded in its chat before anything acts on it, whether or not an agent is woken by it. A platform delivering the same message again records nothing new.
- A message is made of text, attachments and [widgets](#widget).
- Every message reads as plain text, so any person on any platform, and any agent, can follow the chat. A widget brings its own plain-text line.
- Acting on a widget is a message of its own, from whoever did it, in the place the widget is in. It says what they meant, such as answering Q3, approving or picking a place, not how they did it: a button on one platform may be a typed reply on another. Without it, someone reading the chat later could not tell what was chosen.
- A delegate's reply is recorded as said by the agent on the guardian's behalf, under the guardian's account.

## Share link

A read-only copy of chosen turns of a dashboard chat, which anyone with its link can open at `/share/<token>` without signing in.

- Every dashboard chat shares the same way: a common chat, a fork chat, a task chat and a [Concierge chat](#concierge-chat) alike. Its owner picks the turns in the chat's share mode, from Share chat in the chat's menu, and makes the link there. Share chat starts with every turn picked, except in a Concierge chat, where it starts with none.
- Share on a message opens the same share mode with that message's turn already picked. Its owner can make the link at once or pick more turns. There is no link to one message on its own.
- A link carries the picked turns' messages, and the app and project panels its owner leaves in. App panels start in and the project panel starts out, since it opens every file in the project. It never carries the work behind the messages, from any chat: no trace, tool call or subagent, and the page shows none, even for a link made before this rule. It also keeps the name the chat showed for its agent, and the page labels the agent's turns by it.
- The page shows a task chat named in a shared message by its title only, without its status or a way to open it.
- A link is named by the first line of the first picked turn's own message, or else of its first reply. A Concierge chat's link is never named after the chat. Another chat's link takes the chat's name while it has one.
- A link is a snapshot made when it is shared. What is said or changed in the chat later does not reach it.
- The page tells search engines not to index it. A link pasted elsewhere previews with the share's title and a fixed line about Rome, never with the chat's words.
- A chat's links are listed in its share mode, and its owner revokes any of them there. A revoked link opens nothing, and deleting the chat removes its links.

## Delivery

How a message Rome sends stands with its platform: pending, sent or failed. Only a message from Rome has one.

- The platform's answer settles it: sent once the platform took the message, failed with the platform's own words when it refused.
- Once the platform has taken a message, it is sent, even when Rome fails to write that down. Reporting it failed would invite a second real message.
- A failed message reads as never said, to the guardian and to the agent. Sending the text again is a new message.

## Widget

Something shown in a chat that people can look at or act on: a question with choices, an approval request, a map from an app.

- Widgets come from one shared catalog. Each kind has a name, what it holds, what people can do with it (answer, approve or deny, pick), and how each of those reads as plain text. Rome's own question and approval are kinds in it, beside the kinds apps add.
- Each platform draws the kinds it can as its own cards, and sends the plain-text line for the rest. Feishu draws a question as a card. Email sends it as text.
- A place's widget drawing is card or plain text.
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

One of Rome's accounts as Chats sees it: an [account](#account) Rome holds, or held, a [connection](connections.md#connection) to that lets Rome chat as it, with the agent that speaks through it. Its two ends are the account and the agent (Ouou, 2026-11-04).

- A connected account has the identity of its account, platform and the platform's own id, and no other. Its one attribute is its agent.
- It starts when a connection to the account is first connected, with no agent. Disconnecting takes away Rome's reach, not the connected account: the agent link stays, Rome does not hear or speak through the account until it is connected again, and connecting the same account again finds the same connected account with its agent. Unlinking the agent is the guardian's own step.
- A connection reaches one account for its whole life, and at most one connection reaches an account at a time, so a connected account is reached by at most one connection, or by none while disconnected.
- The guardian links, switches and unlinks its agent on the connected account, naming it by its account. The dashboard shows it by its account's platform, id and name, and whether a connection reaches it.
- A message or a participant names an account by platform and the platform's own id, never by a connection. A message remembers who said it, not the connection that carried it. Rome finds the connection when it sends, as the one whose grant reaches the account.
- Its kind of link, [own account](#own-account) or [delegate](#delegate), follows from the kind of connection that reaches it: a bot is always the agent's own account, and the guardian's signed-in account always takes a delegate.

## Account profile

What a platform says about an [account](#account): its display name, handle and avatar. Chats keeps it as a cache, not a record of its own.

- It is keyed by the account, the platform and the platform's own id, and has no identity of its own. Nothing points at it: a reader that holds an account looks its profile up by the same value.
- It is the one place Rome keeps an account's name. The platform fills it through whichever route its word reaches Rome: an address book's sync, what a sender put on a message, or what the platform reported for Rome's own account when the guardian connected or fixed it. A later word replaces an earlier one, except that an address book outranks the rest: nothing else overwrites a profile an address book wrote (Ouou, 2026-11-04).
- On a platform Rome mirrors an address book for, a message does not fill it, since a message may name the sender by another of the account's addresses than the book's own id for the account.
- A connection's grant goes when the connection is disconnected, and the name it reported stays here, so a [connected account](#connected-account) keeps its name after a disconnect.
- It can be dropped and rebuilt from the platforms at any time, and nothing else is lost when it is. An account no profile has been learned for yet is still an account.
- A profile may be missing for an account a link, a dismissal or a message names. A reader then shows the account by its id.
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

- **A link to one message, apart from sharing turns.** It was a second way to share, with its own card, its own link per message and its own rules, beside the share mode every chat already has. Share on a message now opens that share mode with its turn picked.
- **A New chat button, pinned chats and pinned projects at the top of the chat list.** They showed the same ideas twice beside the main chat, and a person had to choose between the Concierge and a new chat for every request. The main chat is where a person talks to Rome, and a common chat starts from Projects.
- **Task chats out of the chat list.** The guardian lost sight of work running on their behalf, and the task list and cards were the only way back to it.
- **Channel as a thing the guardian meets, with its own identity and lifetime.** A channel is one to one with a connected account, so the two words name one thing and the guardian only ever sees the account. Its jobs went to account, connection, connected account and chat. The code's channel layer ([Channels](../architecture/channels.md)) is retired as those words replace it.
- **The agent as part of the connection.** Which agent speaks through an account is the guardian's decision about a chat identity, so it belongs to Chats. Kept on the connection, Connections would hold a fact only Chats uses.
- **The connected account as the connection, with the agent dying on disconnect.** This was the rule until 2026-11-04. Its forces were that a reconnect would inherit an agent the guardian never set, and that a connection with no account reported yet had no record to hold one. Neither holds: the guardian set the agent on that account, and a connection is active only once the platform has reported its account. The account is what the guardian means by "the sales agent", so the link hangs on it.
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
- **"Channel" for a topic chat, as in Claude Duet.** Channel names nothing the guardian meets in Rome, and bringing it back for one kind of chat would give it a meaning no other surface shares.
- **"Sub chat" for a topic chat.** It reads as a chat under another, which is what a task chat is. A topic chat stands beside the main chat.
- **A platform thread for a chat thread.** A platform thread is a place of its own, so its messages leave the chat's timeline. The guardian wants every message in the timeline, grouped only when they open one thread.
- **The guardian sorting messages into chat threads.** It asks them to file every message by hand. Threads start only when the guardian replies, or when a task brings something back.
- **Every message in a chat thread, with the Concierge placing each one.** The Concierge rarely started a new thread, so one thread swallowed the whole timeline, and opening it showed the same list as the timeline.
- **A topic chat as a thread of the main chat.** A thread's messages are messages of its chat, so the main chat would still carry every topic. Separate topics need separate chats.
- **Several Concierges, each with its own memory, follows and tasks.** One event would be triaged and told once per Concierge, and the isolation it promises does not exist inside one Rome. The reasons are in [One Concierge with several chats](../adrs/one-concierge-with-several-chats.md).
- **A reply rule the guardian sets per assistant.** An assistant writes to Rome to get an answer, and no case has come up yet where one should be ignored. The setting waits until one does.
- **An assistant's chat starting at its first message.** The guardian could not find an assistant to write to before it had written, so they could never start the chat.
- **Listing other Romes among the assistants, for now.** Talking to another Rome has no product of its own yet: no way in, and no rule for two Romes answering each other's replies. Every Rome in the account, stopped test stacks included, would also fill the list. Other Romes return to the list when that product is designed.
- **Sending to an account.** A person's account is reached in a chat, and a group or a thread has no account to address. One destination, the place, serves a direct message, a group and a thread alike.
- **A queue of pending sends kept apart from the chat.** It held a message Rome had not yet said outside the chat it belonged to, so the chat and the queue could disagree about what was said. A delivery on the message keeps one record.
- **Assistants' chats as a group in the dashboard's chat list.** Main answers assistants, so the guardian reads their chats now and then rather than watching them. A group beside the guardian's own chats kept them in view all the time.
- **An account record with an id of its own that links and profiles point at.** It would make the account an entity with an identity Rome minted, which no platform has, and Rome never makes an account, so a link to one Rome has not heard from yet would have nothing to point at. The [account profile](#account-profile) keyed by the account gives what the platform says a home without giving the account a lifetime.
