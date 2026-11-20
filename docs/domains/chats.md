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

A reply chain in a [Concierge chat](#concierge-chat). Unlike a [thread](#thread), it is not a place: its messages stay in the chat, in the order they were said, and no client folds a chain away. It is the reply feature of any messenger.

- A chat thread is known by its chat and the id of its first message, its root. Every message is in exactly one chat thread: the one of the message it replies to, or its own when it replies to nothing.
- The root is set when the message is recorded, from the message it replies to, and nothing changes it afterwards. Rome places no message in a thread except where the next bullets say where a message replies.
- A message recorded before chat threads were reply chains is its own thread. The task threads of that time are not kept.
- A reply never crosses chats. A message that replies to a message of another chat, or to one Rome does not hold, replies to nothing.
- A chat thread is not a [task](#task). A task points at the message it started from, and its conversation is the chat thread that holds that message. A task has no thread of its own, and a thread can hold the start messages of several tasks. Which task the Concierge sends a message to moves no message. The owner message that `chat_send` relays to a task becomes the task's start message, so the task's later results reply to it. The Concierge names that message when its turn took several owner messages. Without a name and with several taken, nothing moves.
- Where a message replies. The owner's message replies to the message the owner chose with Reply, else to nothing. The Concierge's message names what it replies to: `say` and `ask_question` take `replyTo`, which is optional. It is the owner message the Concierge answers, or a task's start message for the task's result. Left out, or null, the message replies to nothing, as for one that answers nothing. Rome picks no reply for it. The cards the Concierge itself shows, such as a connect card or a `show_card`, reply to nothing. A name that is no message of the chat is refused for a `say`, and dropped for a question card, since the card is already shown. Rome itself replies for a task's question or approval card, which replies to the task's start message.
- Rome stores the quote of what a reply answers with the reply, the owner's and the Concierge's alike, so it stays whole after the original leaves the timeline. The quote of a card is the card's own words: a task card's title, a question card's question, an approval card's title. It never holds an id.
- A task reporting to its owner's main chat cannot reply across chats, so its report starts a thread there. So does a task whose start message was deleted.
- The timeline shows every message in the order it was said. The Concierge answers several messages in a row, so its replies and the owner's follow different rules:
  - A Concierge message, a card included, that replies to nothing, or to the owner message right above it, is a plain bubble.
  - A Concierge message that replies to the same message as the Concierge message right above it joins that message as a **group**. The gap between them is 2px, and the corners where they meet are 4px, as in a messenger. A card in a group takes the gap and keeps its own corners.
  - Any other Concierge message that replies shows a **quote** inside its bubble, at the top: a small reply arrow and the first line of the original, muted and cut with an ellipsis. A card shows no quote.
  - The owner's message that replies to a message shows a quote always, even when that message is right above it.
  - Time lines are not messages: one shows before the first message, after a gap of an hour between two messages, and when the day changes. A time line between two messages ends a group.
- The quote fills the width of its bubble's content and never widens the bubble. A bubble with a quote is at least 14rem wide, so a short reply still shows a few words of the original. On the owner's bubble the quote is the primary foreground colour at about 82% opacity.
- A click on a quote goes to the original message and tints it for a moment. When the original is not loaded, the chat loads older pages until it is, up to 10 pages, and then gives up without a message.
- Unread belongs to the chat, not to a message. A chat keeps one **read mark**, the time its owner last saw it, set when the chat opens and again while a message arrives and the chat is in view. The chat list, the sidebar and the Concierge's counts say how many of the Concierge's messages were said after it. A chat that opens shows a "New messages" line above the first message the Concierge said after the mark the chat had when it opened, and a pill that goes to the line. The line stays while the chat is open, and a message that arrives meanwhile is never unread. Rome keeps no mark for each message.
- A message that says where its turn came from, such as a routine's, shows that source under it.
- Every chat pages by message, in the order the messages were said, newest first. `GET /api/chat/sessions/:id/messages?limit&before` answers `{ messages, nextCursor }`: the newest `limit` messages, or the `limit` before the opaque `before` cursor, oldest first, and the cursor for the page before, null at the start. The trace rows of the turns the page's messages belong to come with it and are not counted in `limit`, so a source label, a model-switch notice and a failed turn's notice show after a reload. The database order is the only order: by when a message was said, then by the order it was recorded in. The server sends every list in it, a trace row at its place in the list, and a trace older than the page's oldest message right after that message, so a page starts with a message. A client never sorts. It holds a page as it came, puts an older page above, puts a live message last in the order it arrived, and replaces a message it already holds where it stands, so a live update may be out of place until the next reload. A turn's messages are not kept together: when the owner writes a second message while the first is answered, the second message stays where it was said, between the first message and its answer. A share picks whole turns and reads each picked turn's messages by turn id. `type=concierge` answers 400 with the code `not_concierge`, which builds that page a Concierge chat by its main line take as "this chat pages like any other".
- The Needs you button points to a waiting card.
- Reply on a message opens the reply bar alone, quoting it, and the message sends with `replyToMessageId`. Only a message with text takes a Reply: a card takes none.

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

- A person **starts** one from the New chat row or a project's plus in the [chat list](#chat-list), from the search palette, or from an app or a project. It exists from its first message.
- It belongs to one project, or to one folder on a device, and the chat list groups it there.
- Its owner can **rename**, **archive** and **delete** it.
- A settled turn of it can be **forked** into a [fork chat](#fork-chat).

## Fork chat

A chat forked from one turn of another chat, carrying that chat's history up to the turn.

- A person **forks** one from a settled turn of a common chat or of a fork chat. A main chat, a topic chat and a task chat offer no fork.
- A chat forked from a Concierge chat still talks to the Concierge, so it is a topic chat, not a fork chat: it sits under the main chat and offers no fork. A chat forked from a common chat or a fork chat is a fork chat, under Projects.
- It is a chat of its own once forked: what is said in it does not reach the chat it came from.
- It keeps the folder of the chat it was forked from, and the model it was forked with.

## Reaction

An emoji the Concierge puts on its owner's message in a [Concierge chat](#concierge-chat), as a reaction in a messaging app does. The Concierge sets it with its `react` tool. It takes the place of an acknowledgement message, and it is a quiet signal: the Concierge uses it only for what its owner need not notice.

- The Concierge picks one of a fixed set: 👍 ✅ ❤️ 🙏 😂 🎉 🤔. 👀 is not one: it is the working [status](#status), which Rome sets. It names the message with the `message_id` of its `<chat_thread>` line, and may leave it out when the turn holds one owner message. A message that is not its owner's, or is in another chat, is refused. It also clears a reaction.
- A message has at most one reaction. A new one replaces it.
- It stays, like a reaction in a messaging app. The Concierge changes it only when that helps.
- The Concierge handles each message in one way. It answers with a message, or it starts a task, or it only reacts. 👍 (a plain yes, or an instruction noted), ❤️ and 🙏 (thanks) and the like answer a message that needs no answer. A thanks or an OK gets ❤️ or 👍, or one short sentence, and never a task. ✅ alone says a small thing the Concierge did itself is done.
- A task's result most often comes as a message.
- It never says one thing twice: no reaction that repeats its message, no ✅ with a result message.
- Rome sets ✅ only as a fallback when a turn ends without answering. A turn that completes and leaves a message it started with without a reply, a reaction, a working mark or a task gets ✅ on it, so its owner always sees a response. Any message the turn said counts as a reply, and a message that joined the turn gets none. When Rome reminds the turn of an answer it left unsent, the ✅ waits for that reminder, and an answer it sends counts as the reply. A turn that failed shows ⚠️ instead. Rome sets no other reaction. How the work on a message stands is its [status](#status), which shows over the reaction.
- A message shows one emoji for its whole life. A message that showed working takes no reaction, even once answered: `react` leaves it as it is and tells the Concierge so, and the Concierge answers it in one short line instead.
- It is not a message. It never reaches the phone as a push, it does not answer the message, and it does nothing when pressed. A turn that only reacts is silent.
- Only a Concierge chat has them: a [main chat](#main-chat) or a [topic chat](#topic-chat). A common chat has none, and neither does a task chat.
- Rome stores it on the message. The message carries `reaction`, and a client that watches the chat hears `message_reaction` when it changes. Clients draw whatever string the server sends, so the set grows on the server only.
- A reaction is no status: the Concierge chooses a reaction, and Rome derives the [status](#status). A task that works also shows in the [task list](#task-list) and by its [task link](#task-link), and a turn that works shows the typing dots. A turn that failed shows in the failed mark of the sidebar. A task that failed is told to the owner by the Concierge.
- The **typing dots** say the Concierge is writing a message now. The server tells each client, web and iOS, how the running turn shows them, with `message_writing` on the chat's session topic: `{ sessionId, turnId, mode, writing }`, sent when the turn starts, whenever `writing` changes, and with `writing` false when it ends. A client that subscribes gets the running turn's latest at once. On Claude the `mode` is `exact`: the dots show while `writing` is true, from the first word of a `say` call until the call lands. On Codex, and any provider that cannot say when it writes, the `mode` is `simulated` and `writing` stays false: each message of the turn that arrives while the chat is open waits behind the dots for a moment before it shows, by its length, half a second to one second, and several wait one after the other. Nothing is inferred from the turn's other work. A quiet turn, one that is housekeeping, shows none until it says something, so its first message never waits.

## Status

How the work on its owner's message in a [Concierge chat](#concierge-chat) stands, as Rome derives it: `working` (👀) or `failed` (⚠️). A message with neither has none. The Concierge never sets it, so it does not drift with a model or a prompt.

- **Working** starts once a working tool call of the turn that took the message has run half a second, or at the turn's second working tool call, however short each call is. A working tool is any tool other than `react` and those that send a message or a card, such as an action, a data read or starting a task chat. It marks every message the turn started with. One quick call that the turn follows with an answer or a reaction never shows it, so a "thanks" or a quick note does not flash 👀.
- A message that joins a turn already running, taken after the turn called a tool, never shows working on its own. It works only by a task made for it. This keeps a "thanks" sent mid-turn free of 👀, at a cost: a real request sent mid-turn has no mark until its reply. The 👀 on the earlier message and the typing dots show the Concierge is busy meanwhile.
- Working ends when the turn answers the message with a message, or ends with no task open for it. A task made for the message, started for it or given its words in that turn, keeps it working while the task is [active](#task) and until its result is sent. The message that tells the result settles it at once, not when its turn ends. Then the message keeps how the task ended for it, and the task's later work, a scheduled run or its owner typing in its chat, leaves it alone. A scheduled task is never made for a message, and a task made scheduled later lets go of its message once its result is told. A task waiting on a one-off check, as when it deferred a follow-up, still works for the message. A task that waits on its owner does not keep the message working: its [task link](#task-link) and the Tasks button show that it needs them, and the message works again once its owner answers and the task runs. A task follows only the newest message made for it: an older message given to the same task settles when a newer one is, for good, and a message given to it again takes it back.
- A message handed on to a newer turn while it works keeps working. That message then carries the turn's work: a newer message beside it, such as a "thanks", works only by a task made for it.
- **Failed** is set when the turn fails before answering the message and no task made for it got done or went on to a newer message, when a task made for it ends failed, including one whose start failed, or when Rome gives up telling a task's result, once none of its tasks is still open. A stop or a newer input is no failure. It stays, unless a turn takes the message again.
- A restart fails the open messages whose turn it cut off, so none stays working. A turn startup continues, or one continued after a usage limit, shows working for the messages its failure left.
- A message the turn reacted to was handled so: it never shows working, from that turn or from a task made for it later, and shows no failed from that turn, even when it is handed on or the turn fails or is cut off. A reaction taken back makes it the turn's work again. A message that showed working takes no [reaction](#reaction), so its badge never switches from one emoji to another.
- One badge shows it, the [reaction](#reaction)'s round badge on the bubble's top-left corner: the status while there is one, else the reaction. The same badge changes its content and fades as a reaction does, and the room for it is always kept, so the timeline never moves. It only shows, and pressing it does nothing. The typing dots are apart from it, and both may show at once.
- A settled message stays as it settled: once its turn answered it and no task follows it, a task's later ending, a failure or a newer message taking a task over changes nothing on it.
- Each message has its own. A status never pushes to the phone.
- Rome derives it from the turn that took the message and the status of each [task](#task) made for it, which it reads from the task chat's own facts and its row. The message carries `status`, absent when it has none, beside `reaction`, and a client that watches the chat hears `message_status` `{ sessionId, messageId, status }` when it changes, with `status` null once it has none. A client shows none for a status it does not know.
- Only a Concierge chat's owner messages have one. Messages from before it have none.

## Concierge chat

A dashboard chat where its owner talks with their Concierge: a [main chat](#main-chat) or a [topic chat](#topic-chat). Every Concierge chat of one owner talks to the same Concierge, with one list of follows and one set of tasks. Memory is one for every owner.

- A Concierge chat is a chat of its own, not a thread. What is said in one does not show in another, and each has its own agent session.
- The Concierge reads another Concierge chat of the same owner when the question needs it, and not on every turn. What it keeps across chats is what it writes to memory, follows and tasks.
- While the Concierge is on, the guardian and every dashboard admin each have their own Concierge. App users have none.
- A Concierge chat is private to its owner: to anyone else, the guardian included, it does not exist. So is a fork or a subagent session of it, or of a task chat it started, from the moment it is made.
- Its follows and unfinished tasks go to its owner's main chat when it is archived or deleted, and everything that reported to it stays its owner's. Archiving or deleting it can instead stop them, when its owner chooses so.
- A dashboard admin dropped from the allow-list keeps their Concierge chats and follows, but their Concierge tells them nothing until they are back on the list.
- Each follow sends its alerts to one Concierge chat: the one it was followed from, until its owner **moves** it to another. One owner follows one thing once, whatever chat asks for it. Two owners may follow the same thing, and each hears it.
- Digest times, quiet hours and the time zone they are read in are each owner's own.
- A Concierge chat holds only its owner's messages and the Concierge's. What a routine, an app or another agent sends into one, a task chat's agent included, is no message there. It wakes the Concierge with a quiet turn whose input stays in the turn's trace. Its owner never reads the text it sent, and no reaction marks it. When someone else made the Concierge speak like this, rather than its owner, each message it says gets one quiet label under it naming who, such as "Routine · Daily summary", "Agent · Flint", "App · Inbox" or "Automation". The Concierge's own wake-ups, a check it set coming due, what it follows and its digest, label nothing. The label opens nothing. A turn that says nothing shows nothing. An automated message from before this rule, one sent on its owner's behalf included, draws no message either and labels its turn's replies the same way.
- A Concierge chat can start [task chats](#task-chat), and each task's result comes back to the Concierge chat that started it. A Concierge chat's [task list](#task-list) lists only its own tasks: the main chat's lists the tasks that report to the main chat. A Concierge chat sends to, and forwards cards from, only its own tasks. A link to another of its owner's chats' tasks still draws as a live chip there. It can read another chat's task, and starts its own task for the same work.
- Every Concierge chat can do the same things. Only what the Concierge does unasked differs, and what its owner asks outright wins. A progress report covers the tasks that have not ended and those that ended in the last day. Asked for progress in a topic chat, the Concierge reports the tasks started from that chat, which `chat_list` lists with `here`, and every task when its owner asks for all of them. In the main chat it reports every task, grouped by the Concierge chat each came from, the main chat's first. A progress report is one message, a list with one line per task: its [task link](#task-link), then only what the link's status mark cannot say. A request in a topic chat about another topic gets a one-line question: take it to the main chat or to a new topic chat.

## Main chat

The one Concierge chat each owner always has.

- The main chat exists while the Concierge is on, and it is never archived or deleted. The dashboard offers neither.
- The dashboard's home page and its Chat entry open the main chat while the [chat list](#chat-list) is in Concierge mode. When the main chat cannot be loaded, the dashboard says so rather than opening a blank chat.
- The dashboard opens it at `/message`, for the guardian and for each visitor alike. A topic chat is at `/chat/<id>`. The old `/chat/concierge` address redirects to `/message`.
- Each Concierge chat gets the digest of its own follows. The main chat also gets one when nothing is new anywhere.
- Alerts and tasks whose Concierge chat is archived or deleted come here.
- In the header of every Concierge chat, a topic chat's included, and in the Concierge's own copy, the dashboard calls the Concierge by the name the guardian gave their agent (else "Rome", as the main agent). A topic chat's own name shows in the chat list. An open topic chat also names itself in its message box, whose placeholder reads "Message in …" with the chat's name. The header keeps the Concierge's name, and the main chat's message box is unchanged. The main chat is stored as "Main chat", and the chat list labels it "Main chat" in the dashboard's language. Product copy never names it "Concierge".

## Topic chat

A Concierge chat its owner starts for one topic, such as the calendar or a project. It stands beside the main chat, not under it.

- A topic chat starts when its owner **starts** one, from the dashboard or by asking the Concierge. The Concierge never starts one on its own. It starts on the model the main chat uses.
- One started from the dashboard opens blank, like a new chat, and exists from its first message, which names it. One the Concierge starts with a name keeps it, and the main chat's name never changes on its own.
- Its owner can **rename**, **archive**, **unarchive** and **delete** it. Archiving or deleting it moves its follows to its owner's main chat, and its tasks report there while it is archived or gone. The Concierge says so there. When it has follows or open tasks, the archive and delete dialogs list them and ask what happens to them: they move to the main chat, which is the default, or the follows end and the tasks stop with the chat. Stopped this way, nothing moves and the main chat gets no notice. With none, it is archived without a dialog.
- Unarchiving it asks whether the follows its archive moved to the main chat move back to it, which is the default, or stay. Only those still in the main chat are listed: one its owner ended or moved elsewhere since is not. With none, it is unarchived without a dialog. Its tasks need no question: they read as its own again.
- An owner may have any number of topic chats.

## Task

One piece of work the Concierge hands to another agent. A task is its [task chat](#task-chat): the task's id is the chat's id, and its name is the chat's name. It belongs to the Concierge chat that started it, and Rome keeps beside the chat only what the chat does not hold: the Concierge chat it reports to, its start message, the Concierge's private note, and the facts Rome keeps for reporting (a result not yet reported, a report given up, a wait that expired, a no-response not yet listed, when it ended, when it was stopped).

- A task exists once the Concierge has started its task chat. There are no tasks without one: the Concierge never writes a task to start later. The chat is made before its first turn runs, so a task whose start failed is a task chat whose first turn failed. It is ended·failed, its owner opens it to read the error, and writes in it to try again.
- Rome **derives** a task's status from facts it holds, the task chat's own and the row's. The status is one of four, checked in this order:
  - **Waiting for you**: its task chat has an unanswered question card or approval, opened less than a day ago.
  - **Active**: a turn runs or is queued in its task chat, or its result waits for the Concierge to report it.
  - **Later**: a check is scheduled for it and nothing runs, or its schedule has a next run. A task with a check shows when it is due.
  - **Ended**, with a reason: done, failed, stopped, or no response, when a wait went unanswered for a day.
- A stopped task is always ended·stopped, whoever stopped it: the Concierge, its owner, or archiving or deleting its task chat. New words sent to it take it up again, whether the owner types them in its chat or the Concierge passes them on, unless its chat is archived: it is active once more.
- A stop, an archive or a delete turns down the task chat's pending approvals, so nothing approved later runs for a task that ended. Archiving a task chat stops its task if it is still open, and archived, the task is out of the [task list](#task-list). Unarchiving the chat lists it again, still stopped. Deleting the chat deletes the task with it. An ended task leaves the task list a week after it ended.
- Its owner **stops** a task from its row in the [task list](#task-list). Rome stops it at once, without a turn of the Concierge, which hears of it quietly. A Stop in a task chat stops its task the same way, except a scheduled task's: there it ends only the run under way, turning down what that run asked for, and the schedule and its checks stay. Only the task list's Stop ends a schedule. Its owner can also **mark a one-off task done** from the task list: it ends done, and its work, checks and approvals stop as a Stop stops them, and the Concierge hears of it quietly. However an approval in a task chat is decided (approved, rejected, or turned down by Rome), the Concierge hears the decision quietly, even when no turn of the task follows it. Stop in a Concierge chat ends only that chat's turn: the tasks it started keep running, and the task list keeps showing them.
- A message whose turn its owner stopped before an answer stays stopped: the next turn is told of it, and takes it up only when its owner asks again.
- Every card and approval open in a task chat is one wait, which began at the oldest of them. A wait nobody answers within a day ends the task for no response, all of it at once, and it waits for its owner no more. A card said before that day ran out stays part of the ended wait. Only one said after it begins a new wait. Its question card closes, marked expired, and takes no answer: its owner carries on in the chat. A pending approval is turned down, and the task chat's turn finishes as on any refusal. The Concierge hears of it quietly, says nothing and asks nothing, and the next digest lists the task once. That line is the only time the Concierge mentions it. A task that ended for no response is ended, even when its result was never told.
- The Concierge **schedules a check** on a task with `defer`, naming its task chat, for a time or for an event with a deadline. The task is later until the check is due. The check shows on the task's row in the [task list](#task-list). Its owner calls a check off by asking the Concierge, which leaves the task in place. Stopping or archiving the task cancels its checks, and a check of a stopped or archived task never wakes its chat. A task checked three times and still waiting comes up in the next digest, so the Concierge asks its owner rather than check again.
- A task may **repeat on a schedule**: every day, or on some weekdays, at a time in its owner's zone. At each run Rome sends the task's brief into its own task chat, with no turn of the Concierge, and the result comes back as any task's does. Every run uses the same task chat. Between runs the task is later, and its row says when it repeats and when it runs next. Its owner skips a run by asking the Concierge, which skips that one run only. Stopping the task removes its schedule, and the Concierge can change or remove it. A run set to report only when it matters, that finishes with nothing to ask, goes into the next digest. Recurring work for an owner is a scheduled task, never an automation that sends into a Concierge chat. [ADR](../adrs/scheduled-tasks.md)
- The status, the task list and the [task link](#task-link) all read the same derived result. Rome tells the task list again whenever a fact changes it, however that change was read. An app from before reads the state the Concierge used to write, mapped from the status.
- The Concierge **names** a task by starting its chat, and renames it by renaming the chat: there is one name. It writes only a private note beside it. Starting a task chat makes it active.
- Rome tells the Concierge what a task's chat does, and marks a task not synced when the Concierge never takes in what it was told.
- A task points at its start message, and its conversation is the [chat thread](#chat-thread) that holds it.
- A task reports to its owner's main chat while its Concierge chat is archived or deleted. Nothing moves it: it reads as the main chat's, and as its own chat's again once that chat is unarchived. A report in the main chat cannot reply to a message of the archived or deleted chat, so it starts a new thread there.

## Task chat

A chat the Concierge starts to hand one piece of work to another agent. It belongs to the Concierge chat that started it, and its result comes back there. After it starts, the chat is the [task](#task).

- A task chat is private to the owner of the Concierge chat that started it, who alone can open it and write in it. The chat knows the Concierge chat it reports to: its header links back to it, and the [chat list](#chat-list) marks that Concierge chat while the task chat is open.
- A task chat carries one piece of work. It gets no alerts and no digest.
- A task chat is not in the [chat list](#chat-list). It opens from its row in the [task list](#task-list) and from a [task link](#task-link) in a Concierge message, and search finds it.
- The Concierge never copies a task chat's cards into a Concierge chat. The owner answers a task's question in the task chat, or in plain words in the Concierge chat, which the Concierge passes on with `chat_send`. A question passed on counts as answered once the words reach the task chat. An approval is decided only in its task chat. The Concierge may forward a card the task chat showed, as it is, when it tells a result. A card an app shows, such as a sign-in, opens the task chat to answer it. A question or approval in any chat, a common chat's or the main agent's included, folds the same way once settled. The Activity page shows approvals whole.
- A message that holds a task card or a copied question card, from before task links, keeps drawing it: the card shows what its task chat waited on, folds once settled, and shows one quiet line in any chat but its owner's Concierge chat or when it cannot be found.

## Task link

A link to a [task chat](#task-chat) in a Concierge message, a Markdown link `[name](#rome-task=CHAT_ID)`. The Concierge writes it with the `link` that `chat_start` and `chat_list` return, and it is the only way the Concierge refers to a task chat.

- The dashboard and the iOS app draw it as an inline chip: the task chat's status mark and its current name on a faint fill of the text colour, so it reads on any bubble and never makes its line taller. The link's own text is only a fallback while the name loads. The status word is in the chip's tooltip and its label for a screen reader, never on the chip, and only the mark carries colour: needs you a warning-coloured alert, active the spinning ring in the running blue, done a green check, failed a red cross, and in quiet grey later a clock, stopped a square in a circle, no response an empty circle. The hues are a little softer than the full-strength tokens (80%), and the ring stands still under Reduce Motion. The mark is about 80% of the text's size, on its baseline. The [task list](#task-list)'s rows use the same marks and colours.
- The chip opens the task chat, and its status changes live, as the task chat runs.
- It names a task chat of the message's owner, started from any of their Concierge chats. Its status changes reach the chip through the task events of the Concierge chat it is drawn in, which fire for every task of that chat's owner. A link to a task chat of another owner, or to none, reads as plain text. In a push, a quote, another channel and an older app build, a link reads as its text.
- Nothing is copied: no card and no question is sent into the Concierge chat by a link.

## Task list

The list in a [Concierge chat](#concierge-chat)'s side panel that answers "what is my agent doing for me in this chat?": its task chats, and the reminders, routines and follows that run for it, in one list. The dashboard labels it Tasks. Its owner opens it from the Tasks button in the chat's header, which has a dot while a task chat needs its owner. The agent's logo opens nothing. On a phone it opens in a sheet. The iOS app shows the task chats and the rest as two tabs of the Agent page, Tasks and Routines, which the header's Tasks button and ⋯ menu open on that tab, and its mascot opens as it was last.

- It is its owner's only, like the chat: the guardian and each visitor see only their own chat's list, and an action on another person's chat is refused as if the chat did not exist. A common chat has none for now.
- It gathers what Rome already holds and decides nothing: a task shows its derived status, and a check, a follow and a routine show as their own record says.
- It lists only the chat's own work: its task chats, the reminders it set, its follows, and the routines that work for it or for one of its task chats.
- It is one list of groups, with no tabs or filters, and a group with no rows is left out:
  - **Needs you**: a task waiting on its owner's answer or approval, a scheduled task's run included. The oldest wait first.
  - **Active**: a task at work or whose result waits for the Concierge, a scheduled task's run included. The latest change first.
  - **Later**: what comes once: a task with a check, a reminder no task has, and a one-off routine not yet due. The soonest first.
  - **Scheduled**: what repeats: a scheduled task between its runs, a repeating or event routine, and each follow on a row of its own. The soonest next time first, and a row with none last.
  - **Ended**: done, failed, stopped and no-response tasks of the last week. It starts folded and shows the newest twenty, then more on request.
- A scheduled task moves between the groups run by run: Active while a run works, Needs you while a run waits on its owner, Scheduled between runs.
- The routine that watches a follow's events, the digest's routine, a routine of no chat, a one-off that has fired, and an archived task are in none.
- A row reads the same way for every kind: its name, then one line of its state and the time that goes with it, such as "Active · 25 min ago" or "Done · 2 hr ago". A scheduled task's line says when it repeats and when it runs next. A follow's line says its service, its digest times and its next digest. A check for a task, a schedule, a paused routine and a failed last run all show on that line, never as a row or a mark of their own. The word for active is Active everywhere: in the group, on the row and in the chip's tooltip.
- Pressing a task chat's row opens its chat. Pressing any other row does nothing.
- Each row's actions are in its ⋯ menu, shown on hover and always on a touch screen. A task that has not ended has **Stop**, and stopping a scheduled task ends its schedule. A reminder has **Cancel**, a follow **Unfollow**, and a routine **Pause** or **Resume** and **Delete**. An ended task has none. A one-off task that has not ended can also be **marked done**: hover turns its status mark into a check that marks it, and on a touch screen its ⋯ menu holds Mark as done. Delete and Unfollow ask first, since neither is undone from the list; every other action applies at once and shows on the row until the list reads again. A menu item acts only on a press that starts on it.
- A fired check and a deleted routine leave it, since neither has an outcome to show.
- It has no New button: recurring work starts by asking the Concierge, which makes a scheduled task.
- It changes as the work does, without being opened again.

## Chat list

The dashboard's list of a person's chats, beside the rail. Every dashboard person gets the same list, with their own main chat in it.

- It has two modes, Chat and Concierge, and a switch of two icons on the left of its header, with the list menu on the right, changes between them. The header has no title. The dashboard calls Concierge mode "Agent" in the switch, since product copy never says Concierge. Each mode lists one kind of chat, so no chat is in both.
- Chat mode starts with a New chat row, which opens a blank chat. Under it, the Projects section holds the common chats and fork chats, grouped by project or by device folder, with the default project first. The default project's row is always there, under every filter, even when it holds no chat. A plus on a project row starts a chat in that project, and the composer can still move it to another project before its first message. The plus shows on hover, and always on a touch screen.
- Concierge mode starts with a New topic row, which opens a blank topic chat. Under it come the main chat, labelled "Main chat", and the topic chats, latest first, with no More row: the list shows them a page at a time, and scrolling near its end shows the next page. No task chat is in the list, and there is no Tasks panel: the [task list](#task-list) is in each Concierge chat's side panel. While a task chat is open, the list marks the Concierge chat it reports to.
- A dot on the switch's segment for the mode that is not showing says something there needs a look. The Concierge's dot shows for unread messages in the main chat or a topic chat, and for a task chat that waits for its owner. The Chat dot shows while a common chat or a fork chat is replying.
- Each tab keeps its own mode, and a new tab starts from the last mode the device showed. A device that has shown none starts on Chat. Opening a chat moves the list to its mode: the main chat, a topic chat and a task chat to Concierge, a common chat and a fork chat to Chat. A blank topic chat opens Concierge mode, and any other blank chat opens Chat mode. The switch also opens a chat of the mode it picks: Agent opens the Concierge chat last opened, else the main chat, and Chat opens the common chat or fork chat last opened, else a blank chat. Choosing the mode already showing does nothing. So the mode matches the open chat, and a refresh or a first load keeps following the address. On a phone, where the list is a screen over the chat, the switch changes only the list. A draft in the chat the person leaves stays, as with any other way of opening a chat.
- The new-chat shortcut, Ctrl or Cmd with Shift and O, opens a blank chat in Chat mode and a blank topic chat in Concierge mode. The rail's Chat entry and the home page open the main chat in Concierge mode. In Chat mode they open the common chat or fork chat last opened on the device, or a blank chat when there is none or it is gone.
- Deleting the open common chat or fork chat opens a blank chat, so the list stays in Chat mode. Deleting any other open chat opens the main chat.
- Without a Concierge the list has no switch and no mode. It is the Chat mode list, with any task chat under its project, and a New chat row.
- Nothing in it is pinned, and it is not grouped by date.
- Its status filter, active, archived or all, applies to every chat in both modes. Under archived the main chat is hidden, since it is never archived, and an archived topic chat stays under the main chat, not in Projects.

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
- Acting on a widget that asks something is a message of its own, from whoever did it, in the place the widget is in. It says what they meant, such as answering Q3, approving or picking a place, not how they did it: a button on one platform may be a typed reply on another. Without it, someone reading the chat later could not tell what was chosen.
- Acting on a widget that only shows something, such as ticking off a meal on today's meals, is not a message. It changes the app the widget belongs to, and the chat shows the change only through the widget.
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

- Widgets come from one shared catalog. Each kind has a name, what it holds, what people can do with it (answer, approve or deny, pick), and how each of those reads as plain text. Rome's own question and approval are kinds in it, beside the kinds apps add. The one exception is the [agent card](#agent-card), whose look and plain-text line the agent writes each time.
- Each platform draws the kinds it can as its own cards, and sends the plain-text line for the rest. Feishu draws a question as a card. Email sends it as text.
- A place's widget drawing is card or plain text.
- A widget's live state belongs to what it is about. An approval request shows as approved because the approval is.
- An agent shows a widget by calling a tool.
- A widget either asks something or only shows something. One that asks keeps the agent waiting until it is answered. One that only shows something leaves the agent to go on, and nobody answers it.
- An app's widget belongs to the app whose action showed it, and is one of the kinds that app adds. An action cannot show another app's widget.
- A widget is a message of its own, and is known by that message. A message that holds a widget holds nothing else (zhangfan, 2026-11-12).
- A widget's owner is the app that showed it, or Rome for its own kinds, such as the question. A widget keeps no state of its own: what it shows comes from its owner, read again when it is drawn and after each event. An agent card is the exception: it shows what it held when the agent showed it.
- People do two things with a widget. An **edit**, such as picking an option or typing an answer, changes only what the widget shows on the screen in front of them. An **event**, such as pressing Send or a button that logs a glass of water, asks Rome to act, and carries the edits it needs. An edit never leaves the screen on its own.
- Every event goes to the widget's owner, which alone says what it means: an app's widget calls its app, and Rome's question answers the agent waiting on it. A widget accepts only the events it names, and only from someone who may open its chat.
- A row of a widget may open a link, a web page or a place in Maps. Opening it is not an event: it reaches no owner, and the agent never hears of it.
- What the agent reads of an answer is written by Rome from the widget and the event. Anything the owner app adds reads as the app's, never as the words of the person who acted.

## Location share

Rome's own widget that asks the guardian for where they are right now, once, for one answer: "what is near me", "will it rain here".

- An agent asks only when the answer needs the guardian's current position. A message that names a place, or a city the agent already knows, needs none.
- It is asked only where the guardian alone reads the chat. Anywhere else the agent says it cannot ask here, and why.
- The guardian **shares** or **declines**. Shared, the agent gets the position and how precise it is, never an address. Declined, the agent does not ask again for that answer: it answers without, or asks for a place in a message. A later message that needs the position asks again.
- Where the guardian's own message started the turn that asks, and their device already lets Rome read the position, the client they are looking at shares at once, with no question: the widget shows only that the location was shared, and how precisely. A turn something else started, such as a followed event, a routine, a task's result or another agent, always offers Share and Not now, so outside content never gets the position without a press. Where the device has not asked yet, the widget offers Share and Not now too, and the device asks for permission on Share. Where the device refuses, the widget says so and Not now declines.
- A share that arrives once others can read the chat, as when visitors were let in while it waited, is taken as declined, and the position reaches nobody.
- A message the guardian sends instead closes it, as declined. Whichever of the guardian's clients answers first answers it, and it then takes no other answer.
- The client reads the position from its device and sends it with the share. It is the one event a client fills in itself.
- The position reaches that answer only. The chat keeps how the share ended, never where the guardian was, and a location share is not a connection.
- A coarse position, from a desktop's network or a VPN, reads as an area: the agent says "around" the city.

## Agent card

Rome's own widget whose look the agent composes, to show structured content laid out: an itinerary, options compared, a few key numbers.

- Rome owns it. The agent writes how it looks, from the display components of the widget catalog (text, numbers, bar charts, lists, rows, columns, images, progress), and gives its plain-text line with it.
- A number may carry its usual range. The reader, never the agent, says whether it is normal, high or low, so a card cannot misjudge its own numbers.
- It only shows something. It holds nothing that sends an event, no button, pick or field, since no owner would handle it. To ask, the agent uses the question. A row may open a link, a web page or a place in Maps, which tells nobody.
- Its content lives in its message, a snapshot of the card as shown. It reads nothing from anywhere when drawn, and never changes afterwards.
- The plain-text line is the card for every reader that cannot draw it: a text-only platform, the lock screen, and the agent itself reading the chat later.
- An agent shows one only where the place draws cards. Anywhere else it sends the content as a message.
- Any agent may show one: the Concierge in its chats, and every other agent in its chat or task chat, such as a routine's daily summary. Only Rome's own card tool shows one. Anything else that looks like one, such as an app's action, a command's output or another tool with the same name, is not a card.
- The agent uses one only for content with a real structure, at most one per reply, and its messages around the card never repeat it.
- A [task chat](#task-chat) may give its result as one card or several: a few key numbers against their usual ranges, steps, or options side by side, never a short answer or a result that asks its owner something. It still writes its conclusion. The Concierge forwards a card as it is with `card_forward`, by the card's id, one card per call: Rome issues it again, marked as forwarded from the task chat, and it replies to the task's start message. Any card of the Concierge chat's own task chats can go, from any turn. The task event lists the cards of the turn of the task's final answer, and a turn that showed only cards answers with them. A Concierge chat that cannot draw cards gets the card's plain-text line instead. A result with no card is never forwarded: the Concierge tells it with `say`. The Concierge never composes a card from a task's result itself, so no number is typed twice.

## Outputs

The files a chat's agent produced: those it wrote, and those it showed in the chat. The dashboard labels them Outputs, "产出" in Chinese.

- Only what the agent produced is an output. A file the agent wrote is **written**, and a file it showed is **shown**. A helper agent working for the chat's agent produces for the chat too. A file the owner attached, a picture they sent, a web picture the agent linked and an agent card are not outputs.
- Rome records an output when it happens: a write once it succeeds, and a show once the file is copied into the chat. A write that failed or was refused records nothing.
- A file the agent wrote with a shell command counts when the command plainly names it: a `>` or `>>` redirect, `tee`, `touch`, or where `cp` or `mv` put it. So does a local file the agent's reply links and that changed during the turn. A file the reply only cites does not count. Either counts only when the command or turn succeeded and the file is there, in the projects or memory folder. A log in a temporary folder or the owner's upload does not count. A relative path after the command changed folder is not read, as there is no telling where it went. A file a script or program wrote from inside, which no reply links, is not seen.
- A link only stands in for a file nothing else recorded. When a [Concierge chat](#concierge-chat)'s reply passes on a task chat's file, the output stays the task chat's.
- A file is one output however often it was written or shown, and it reads as the latest time: its kind, its time and the chat it came from are that time's. A file written and then shown is one output, shown.
- A written file can move or go after it was written. Rome does not follow it: the output stays, marked moved or deleted, and nothing can be opened from it.
- A [Concierge chat](#concierge-chat)'s outputs hold its own and those of every [task chat](#task-chat) it started, each of a task chat's named after that task chat. A task chat lists its own.
- Outputs are as private as their chat, and go when the chat is deleted.
- A chat from before outputs were recorded is read back once, in the background, from the first time its outputs are listed: the files its stored traces still show it wrote or its replies link, and the files its agent's messages link from the chat's own store, except one the owner attached. Until it is done, the list shows what is recorded and says it is still finding earlier files. A trace that was archived, or stored whole from before traces were stored step by step, is not read back, so an old chat can miss a write.
- On the dashboard every chat's header shows its agent in a round badge with the chat's name under it, and its status in a Concierge chat. The badge holds the Rome mascot, or the app's icon in a chat bound to an app's agent. The name is the Concierge's name in a Concierge chat, the chat's title or "New chat" elsewhere. The badge opens nothing. On the right one capsule holds two buttons, Tasks and ⋯, with the side panel's button apart from it. Tasks opens the chat's task list, with a dot while a task chat needs its owner. A chat with no task list, an ordinary chat or a topic chat before its first message, has ⋯ alone. Hovering ⋯, or a click or tap on it, shows its menu in three parts: what opens in the side panel (Outputs, and the project when the chat was started in one the owner chose), then what is done to the chat (Rename, Share chat, Archive or Unarchive, Delete, and only Share chat in the main chat), then the model that answered the chat's last turn, as text. The iOS app's header has the same capsule in glass, Tasks and "…": Tasks opens the Agent page on its Tasks tab, with the dot (a topic chat before its first message has "…" alone), and "…" holds Outputs and Routines, then the chat's Rename, Share, Shared links, Archive and Delete.
- A topic chat before its first message has the same header, badge and name included, and its status capsule shows a welcome where an idle chat's capsule is hidden. Above the composer sit three suggestions. Picking one puts its full message in the composer, unsent. The first message keeps the header where it is: the suggestions go, and the capsule turns to the chat's own status.
- The Outputs tab lists the chat's outputs with their total, filtered to all, documents, spreadsheets or pages, under Today and Earlier. A row names the file without its extension, says what kind of file it is, and either how the chat's agent made it or the task chat it came from, which opens that chat. Choosing a row previews it in its place: a picture as a picture, Markdown rendered, other text as text, anything else as a download. Nothing in it runs. A plain text (.txt) or Markdown file the chat's agent wrote in the projects folder, up to about 1 MB, shows an Edit button that opens it in the Projects editor in place, with no file tree. Edits save as they do on the Projects page, and Done returns to the preview. Every other file stays a preview. Opening a link to a file in a message opens that file there when it is one of the chat's outputs, whichever time it was written or shown the link names, by its project path, its memory path, its copy or its absolute path. A link to any other memory file or folder opens it in a sheet beside the chat, and the chat stays where it was. Nothing marks a new output.

## Client

One of the apps a person uses to reach a [platform](#platform): the dashboard in a browser and the Rome app on a phone are two clients of the dashboard.

- A client draws widgets and sends what people do with them. It decides nothing about what an event means: that is the widget's owner's (zhangfan, 2026-11-12).
- Two clients of one platform show the same widget the same way and send the same events for it.
- A client shows an event as sent once Rome takes it, and leaves the widget usable when Rome does not.

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

- **Event names every widget shares,** such as one name for "answer the agent" on any widget. Who owns a widget already says what its events mean, and a shared name made every client learn it.
- **Each client deciding what a widget event means.** The rule lived once per client and drifted between the dashboard and the phone.
- **A link to one message, apart from sharing turns.** It was a second way to share, with its own card, its own link per message and its own rules, beside the share mode every chat already has. Share on a message now opens that share mode with its turn picked.
- **A New chat button, pinned chats and pinned projects beside the main chat in one chat list.** They showed the same ideas twice beside the main chat, and a person had to choose between the Concierge and a new chat for every request. The chat list has two modes instead. People who long used common chats need an entry of their own, and one kind per mode means nobody chooses between the Concierge and a new chat inside one list: Concierge mode starts topic chats, and Chat mode starts common chats. Pinned chats and pinned projects stay out of both.
- **A task panel and a checks strip above the message box, beside the routines.** The same check showed on a task's row and in the strip, and a scheduled task was both a task and a routine, so the owner read one piece of work in up to three places. One task list per chat lists each piece once.
- **Every action on every row of the task list,** such as rename, skip the next run, archive, move and a routine's detail page. Every row grew its own buttons, so the list read as a control panel rather than an answer to what runs. Each row keeps the few actions that end or hold what it shows, in a ⋯ menu; the rest stay with the Concierge, the Routines page and settings.
- **Task chats in the chat list's Tasks panel, and task chats out of the chat list.** The panel and the task list showed the same running work in two places. Task chats left the chat list first, and the task list and cards were the only way back to them. The task list in each Concierge chat is now the one list, and a task link in the Concierge's message is the way to one.
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
- **A platform thread for a chat thread.** A platform thread is a place of its own, so its messages leave the chat. A chat thread keeps its messages in the chat, in the order they were said.
- **The guardian sorting messages into chat threads.** It asks them to file every message by hand. The owner only taps Reply, as in any messenger.
- **A stack under the first message of each chat thread.** The Concierge replied inside a thread to most messages, so the owner met a stack where they expected an answer and had to open it to read the reply. Replies stay in the timeline, each with the quote of what it answers.
- **One thread per task, placed by Rome from what the Concierge names.** Placement depended on the model naming the task, and follow-ups that named nothing fell out of the thread.
- **Every message in a chat thread, with the Concierge placing each one.** The Concierge rarely started a new thread, so one thread swallowed the whole timeline, and opening it showed the same list as the timeline.
- **A topic chat as a thread of the main chat.** A thread's messages are messages of its chat, so the main chat would still carry every topic. Separate topics need separate chats.
- **Several Concierges, each with its own memory, follows and tasks.** One event would be triaged and told once per Concierge, and the isolation it promises does not exist inside one Rome. The reasons are in [One Concierge with several chats](../adrs/one-concierge-with-several-chats.md).
- **A reply rule the guardian sets per assistant.** An assistant writes to Rome to get an answer, and no case has come up yet where one should be ignored. The setting waits until one does.
- **An assistant's chat starting at its first message.** The guardian could not find an assistant to write to before it had written, so they could never start the chat.
- **Listing other Romes among the assistants, for now.** Talking to another Rome has no product of its own yet: no way in, and no rule for two Romes answering each other's replies. Every Rome in the account, stopped test stacks included, would also fill the list. Other Romes return to the list when that product is designed.
- **Sending to an account.** A person's account is reached in a chat, and a group or a thread has no account to address. One destination, the place, serves a direct message, a group and a thread alike.
- **An automation's text as a message in a Concierge chat.** It read as an odd bubble from the owner's own agent, and what it showed was an instruction, not news. The owner hears what the Concierge makes of it.
- **A queue of pending sends kept apart from the chat.** It held a message Rome had not yet said outside the chat it belonged to, so the chat and the queue could disagree about what was said. A delivery on the message keeps one record.
- **Assistants' chats as a group in the dashboard's chat list.** Main answers assistants, so the guardian reads their chats now and then rather than watching them. A group beside the guardian's own chats kept them in view all the time.
- **An account record with an id of its own that links and profiles point at.** It would make the account an entity with an identity Rome minted, which no platform has, and Rome never makes an account, so a link to one Rome has not heard from yet would have nothing to point at. The [account profile](#account-profile) keyed by the account gives what the platform says a home without giving the account a lifetime.
- **"Artifacts" for a chat's outputs.** Artifacts already names an app's agents, actions and skills, so one word would name two things.
- **The Concierge setting 👀 itself.** The rule of #2191. 👀 then meant only that the model remembered to set and clear it: a failed turn showed nothing, and a missed clear left 👀 for good. Rome derives it, so it holds whatever the prompt says (#2209).
- **👀 as soon as a turn takes a message.** A "thanks" flashed 👀 before its ❤️. Working starts once a working tool call has run half a second, or at the turn's second working tool call.
- **Working after 5 seconds without an answer.** A reply that took long to write flashed 👀 just before it landed, and a "thanks" that joined a busy turn could show 👀 by its own timer before its 🙏. Working comes only from real work ([status](#status)).
- **A reaction after working.** A quick memory note, `defer` or stop showed 👀 and then switched to 👍 or ✅. A message keeps one emoji, so one that showed working takes no reaction, and the Concierge answers it in one short line ([reaction](#reaction)).
- **Working out a settled message again from its task links.** Each later task event could turn an answered message back to 👀 or ⚠️, and every review round found the next path. A settled message stays as it settled: a task's later ending, a failure or a newer message taking a task over changes nothing on it ([status](#status)).
- **A task apart from its task chat.** A task was a row with its own id, title, archive flag and stop state, linked to at most one chat. It could exist with no chat, named two things, and was kept in step with its chat in both directions, so the Concierge worked with two ids for one piece of work. The task is its chat, and a row beside the chat holds only what the chat does not.
- **A one-line summary of each task.** The Concierge wrote one on every report and no screen showed it. The Concierge's report and the task chat's own conclusion say it.
- **Rows the Concierge writes to start later.** A task that was only a row had no chat, so it showed as later for good, and a day-old one was a reminder the Concierge raised. A task starts with its chat. A thing to look at again later is a check with no task.
- **Copying a task chat's card into a Concierge chat.** A task card and a copied question gave the card a life of its own there: folded, waiting on a newer copy, closed. The owner now sees the task as a task link with its live status, and answers in the task chat or in words, as in Claude Code Projects.
- **Tasks and Routines as two views of the task list.** A reminder, a scheduled task and a routine all say when something runs next, and the owner looked in two places to learn what was coming. One list groups them by when they run, and a task chat stays apart by opening its chat.
