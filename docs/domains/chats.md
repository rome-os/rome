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

One [task](#task)'s conversation inside a [Concierge chat](#concierge-chat), which its owner follows on its own. Unlike a [thread](#thread), it is not a place: its messages stay in the chat's own timeline. Only a task has a chat thread, and a task has exactly one.

- A chat thread is known by its chat and the id of its first message, its root.
- A task's root is kept for good: the owner's message that started the task. A task no owner's message started takes the first owner's message sent on to it, or the first thing it brings back. A message already in a thread, another task's or one from before, starts no thread, so a task started for it takes its root the same way. Of two tasks started at once for one message, one takes it as its root and the other takes its root the same way.
- Rome places the messages of a task's thread, never the owner and never by guess. A task's thread holds what the task brings back, its results, question cards and forwards, the owner's messages sent on to it, and the Concierge's answers to those messages. The Concierge's messages that answer the message a task was started for join it too.
- A Concierge message that names its task goes into that task's thread, whatever turn says it. One that names nothing goes by its turn: into the thread of the task the turn reports on, or of the task the turn's one owner's message is in. A turn about several things, as the owner's message and another task's news, or several tasks' news, puts a message that names nothing in no thread.
- A reply to a message in a task's thread is in that thread at once, and nothing moves it. The Concierge reads which task it belongs to. It sends the message on to that task, answers it itself, or starts a new task for it, and Rome refuses to send it on to any other task. A new task started for it leaves the message in this thread and takes its own root from the first thing it brings back. Showing another task's result there leaves the message where it is.
- A reply to a message in no task's thread is only a quote: it is in no thread. A task the Concierge then starts for it takes it as its root.
- Any other message is in no chat thread: an owner's message typed in the chat, the Concierge's answer to one, and every message of a thread from before that no task has, which every client shows as in none.
- A task moved to another Concierge chat leaves its thread behind, and starts a new one there the same way.
- The chat's timeline shows every message in the order it was said, whatever its thread. The thread view shows one task's thread on its own.
- In the chat's timeline, a Concierge message in a task's thread can show the task's title under it, which opens the thread view: a plain message, a forwarded result and a task's question or approval card alike. A task card needs none, since it names its task. When messages of one thread follow each other with nothing between them, only the first and the last of that run show the label, so a run of one or two shows it on each. Another thread's message or a task card ends the run. The owner's messages neither end it nor join it. The label sits as close under a card as under a bubble and apart from the next message, and stays faint until it is pointed at or focused. A long title is cut short, and shows whole when pointed at. The owner's own messages show none, and neither does the thread view. A label shows no count.
- Opening the thread view tints the whole message it opened from, every bubble of it. The view's header opens the task chat.
- Only that label, or the quote in a reply that is in a task's thread, opens the thread view. The quote in any other reply goes to the original message and tints it. Reply on a message opens the reply bar alone, quoting it. Only a message with text takes a Reply: a task card and a question or approval card take none. While the thread view is open, its reply bar reads "Reply to <task title>" and what is sent goes to the task's thread, quoting no message, however the view was opened. A Reply inside the view keeps it so. Closing the reply bar, or sending, closes an open view with it.

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

- Rome derives it, never the Concierge, from two facts it keeps: which turn took the message and whether that turn answered it, and which tasks were made for the message (the ones it started, and the ones its words were passed on to). A message has at most one.
- Working: the turn that took the message has not answered it, or a task made for it waits for its owner, is active or is checked later. A message gets it as soon as a Concierge turn takes it in, before the Concierge says or starts anything.
- Failed: the turn that took it failed before it answered, by an error or a crash. A task made for it that ended failed shows it too, and so does a task whose result Rome gave up telling the Concierge, since its owner was never told. It shows only once none of its work is still open.
- Otherwise none: a task that ended done, stopped or for no response shows no mark, and neither does a turn its owner stopped or a newer input took over.
- A turn answers a message when it ends, or as soon as the Concierge answers it: when its answer names the message, or when the message is the turn's only one and the answer names no task. A message a newer input handed on to the next turn is that turn's, and waits for it. A turn that runs again, as after a usage limit, opens every message it holds again.
- A task's result keeps the message working until a report of it to the Concierge runs to its end, also across a restart. A report that fails or is cut short runs again, even when the Concierge already said the result: a second report rather than a lost one. One the owner stops is not run again, and the message shows its owner was never told. A restart ends every message's turn it cut off as failed, unless it continues that turn, so no mark stays working past the process that set it. A task chat turn a restart ended failed.
- Stopping a task that failed takes its mark away.
- It is not a message. It never reaches the phone as a push, and it does nothing when pressed.
- A common chat has none, and neither does a task chat.
- The working mark says the Concierge has started on the message. Its **typing dots** say something else: the Concierge is writing a message now. The server tells each client, web and iOS, how the running turn shows them, with `message_writing` on the chat's session topic: `{ sessionId, turnId, mode, writing }`, sent when the turn starts, whenever `writing` changes, and with `writing` false when it ends. A client that subscribes gets the running turn's latest at once. On Claude the `mode` is `exact`: the dots show while `writing` is true, from the first word of a `say` or `chat_forward` call until the call lands. On Codex, and any provider that cannot say when it writes, the `mode` is `simulated` and `writing` stays false: each message of the turn that arrives while the chat is open waits behind the dots for a moment before it shows, by its length, half a second to one second, and several wait one after the other. Nothing is inferred from the turn's other work. A quiet turn, one that is housekeeping, shows none until it says something, so its first message never waits.

## Concierge chat

A dashboard chat where its owner talks with their Concierge: a [main chat](#main-chat) or a [topic chat](#topic-chat). Every Concierge chat of one owner talks to the same Concierge, with one list of follows and one list of tasks. Memory is one for every owner.

- A Concierge chat is a chat of its own, not a thread. What is said in one does not show in another, and each has its own agent session.
- The Concierge reads another Concierge chat of the same owner when the question needs it, and not on every turn. What it keeps across chats is what it writes to memory, follows and tasks.
- While the Concierge is on, the guardian and every visitor on the dashboard allow-list each have their own Concierge. App users have none.
- A Concierge chat is private to its owner: to anyone else, the guardian included, it does not exist. So is a fork or a subagent session of it, or of a task chat it started, from the moment it is made.
- Its follows and unfinished tasks go to its owner's main chat when it is archived or deleted, and everything that reported to it stays its owner's. Deleting it can instead stop them, when its owner chooses so.
- A visitor dropped from the dashboard allow-list keeps their Concierge chats and follows, but their Concierge tells them nothing until they are back on the list.
- Each follow sends its alerts to one Concierge chat: the one it was followed from, until its owner **moves** it to another. One owner follows one thing once, whatever chat asks for it. Two owners may follow the same thing, and each hears it.
- Digest times, quiet hours and the time zone they are read in are each owner's own.
- A Concierge chat holds only its owner's messages and the Concierge's. What a routine, an app or another agent sends into one, a task chat's agent included, is no message there. It wakes the Concierge with a quiet turn whose input stays in the turn's trace. Its owner never reads the text it sent, and no status reaction marks it. When someone else made the Concierge speak like this, rather than its owner, each message it says gets one quiet label under it naming who, such as "Routine · Daily summary", "Agent · Flint", "App · Inbox" or "Automation". The Concierge's own wake-ups, a check it set coming due, what it follows and its digest, label nothing. The label looks like a task thread's label but opens nothing. A turn that says nothing shows nothing. A message in a task's thread shows only its thread label, or none. An automated message from before this rule, one sent on its owner's behalf included, draws no message either and labels its turn's replies the same way.
- A Concierge chat can start [task chats](#task-chat), and each task's result comes back to the Concierge chat that started it. A Concierge chat's [task list](#task-list) lists only its own tasks: the main chat's lists the tasks whose chat is the main chat. A Concierge chat sends to and forwards from only its own tasks, and showing a card for another chat's task or pointing its row at a message never moves it. It can read another chat's task, and starts its own task for the same work.

## Main chat

The one Concierge chat each owner always has.

- The main chat exists while the Concierge is on, and it is never archived or deleted. The dashboard offers neither.
- The dashboard's Chat entry and its home page open the main chat. When it cannot be loaded, the dashboard says so rather than opening a blank chat.
- The dashboard opens it at `/message`, for the guardian and for each visitor alike. A topic chat is at `/chat/<id>`. The old `/chat/concierge` address redirects to `/message`.
- Each Concierge chat gets the digest of its own follows. The main chat also gets one when nothing is new anywhere.
- Alerts and tasks whose Concierge chat is archived or deleted come here.
- In the header of every Concierge chat, a topic chat's included, and in the Concierge's own copy, the dashboard calls the Concierge by the name the guardian gave their agent (else "Rome", as the main agent). A topic chat's own name shows in the chat list. An open topic chat also names itself in its message box, whose placeholder reads "Message in …" with the chat's name. The header keeps the Concierge's name, and the main chat's message box is unchanged. The main chat is stored as "Main chat", and the chat list labels it "Main chat" in the dashboard's language. Product copy never names it "Concierge".

## Topic chat

A Concierge chat its owner starts for one topic, such as the calendar or a project. It stands beside the main chat, not under it.

- A topic chat starts when its owner **starts** one, from the dashboard or by asking the Concierge. The Concierge never starts one on its own. It starts on the model the main chat uses.
- One started from the dashboard opens blank, like a new chat, and exists from its first message, which names it. One the Concierge starts with a name keeps it, and the main chat's name never changes on its own.
- Its owner can **rename**, **archive** and **delete** it. Archiving or deleting it moves its follows to its owner's main chat, and its tasks report there while it is archived or gone. The Concierge says so there. When it has follows or open tasks, the delete dialog lists them and asks what happens to them: they move to the main chat, which is the default, or the follows end and the tasks stop with the chat. Stopped this way, nothing moves and the main chat gets no notice. Archiving always moves them.
- An owner may have any number of topic chats.

## Task

One piece of work the Concierge keeps on its owner's task list, with a title, a status and, while an agent works on it, a [task chat](#task-chat). It belongs to the Concierge chat it reports to.

- Rome **derives** a task's status from facts it holds. The status is one of four, checked in this order:
  - **Waiting for you**: its task chat has an unanswered question card or approval, opened less than a day ago.
  - **Active**: a turn runs or is queued in its task chat, or its result waits for the Concierge to report it.
  - **Later**: a check is scheduled for it and nothing runs, its schedule has a next run, or the Concierge wrote it as a row and has not started its task chat yet. A row without a check shows no time. Starting its chat takes it from there, and stopping it ends it.
  - **Ended**, with a reason: done, failed, stopped, or no response, when a wait went unanswered for a day.
- A stopped task is always ended·stopped, whoever stopped it: the Concierge, its owner, or archiving or deleting its task chat. New words sent to it take it up again, whether the owner types them in its chat or the Concierge passes them on or starts its row: it is active once more, as when its owner answers an expired card. A task stopped by archiving or deleting its chat stays stopped.
- A stop, an archive or a delete turns down the task chat's pending approvals, so nothing approved later runs for a task that ended. Archiving a task that is still open stops it. An ended task leaves the task list a week after it ended.
- Its owner **stops** a task from its card or its row in the [task list](#task-list). Rome stops it at once, without a turn of the Concierge, which hears of it quietly. A Stop in a task chat stops its task the same way, except a scheduled task's: there it ends only the run under way, turning down what that run asked for, and the schedule and its checks stay. Only the task list's Stop ends a schedule. However an approval in a task chat is decided (approved, rejected, or turned down by Rome), the Concierge hears the decision quietly, even when no turn of the task follows it. Stop in a Concierge chat ends only that chat's turn: the tasks it started keep running, and the header keeps showing them.
- A message whose turn its owner stopped before an answer stays stopped: the next turn is told of it, and takes it up only when its owner asks again.
- Every card and approval open in a task chat is one wait, which began at the oldest of them. A wait nobody answers within a day ends the task for no response, all of it at once, and it waits for its owner no more. A card said before that day ran out stays part of the ended wait. Only one said after it begins a new wait. Its question card stays answerable, marked expired, and answering it takes the task up again. A pending approval is turned down, and the task chat's turn finishes as on any refusal. The Concierge hears of it quietly and asks nothing, and the next digest lists the task once. A task that ended for no response shows no ⚠️, even when its result was never told.
- The Concierge **schedules a check** on a task with `defer`, for a time or for an event with a deadline. The task is later until the check is due. The check shows on the task's row in the [task list](#task-list). Its owner calls a check off by asking the Concierge, which leaves the task in place. Stopping or archiving the task cancels its checks, and a check of a stopped or archived task never wakes its chat. A task checked three times and still waiting comes up in the next digest, so the Concierge asks its owner rather than check again. So does a row the Concierge wrote a day ago or more with no task chat started and nothing scheduled, once: it stays later until then.
- A task may **repeat on a schedule**: every day, or on some weekdays, at a time in its owner's zone. At each run Rome sends the task's brief into its own task chat, with no turn of the Concierge, and the result comes back as any task's does. Every run uses the same task chat. Between runs the task is later, and its row says when it repeats and when it runs next. Its owner skips a run by asking the Concierge, which skips that one run only. Stopping the task removes its schedule, and the Concierge can change or remove it. A run set to report only when it matters, that finishes with nothing to ask, goes into the next digest. Recurring work for an owner is a scheduled task, never an automation that sends into a Concierge chat. [ADR](../adrs/scheduled-tasks.md)
- The status, the task list, the chat header and the status reactions all read the same derived result. Rome tells the task list again whenever a fact changes it, however that change was read. The state the Concierge used to write stays for apps from before, mapped from the status.
- The Concierge **writes** a task: it creates it and names it. Starting a task chat for one makes it active.
- Rome tells the Concierge what a task's chat does, and marks a task not synced when the Concierge never takes in what it was told.
- A task has at most one [chat thread](#chat-thread), and its root is kept for good.
- A task reports to its owner's main chat while its Concierge chat is archived or deleted. Nothing moves it: it reads as the main chat's, and as its own chat's again once that chat is unarchived. An open task's thread stays behind and is a task's no more, so its label goes and the task starts a new thread in the main chat. An ended task keeps its thread while its chat is archived. Once the chat is deleted, its messages are gone, so its next message in the main chat starts a new thread too.
- A task links one task chat in its life. A task whose task chat could not be started leaves no chat behind, and stays on the list as failed.
- A message a task works for shows a [status reaction](#status-reaction) while the task is open, and until the Concierge reports its result.

## Task chat

A chat the Concierge starts to hand one piece of work to another agent. It belongs to the Concierge chat that started it, and its result comes back there.

- A task chat has a row in its owner's task list. It is private to the owner of the Concierge chat that started it, who alone can open it and write in it.
- Archiving a task chat stops its task: its running work stops, and its row is stopped and archived with the chat, so the task leaves the task list and the Concierge stops tracking it. Unarchiving the chat lists the row again, still stopped. A row archived before its chat stays archived. Deleting the chat stops and archives the row for good.
- A task chat carries one piece of work. It gets no alerts and no digest.
- A task chat is in the [chat list](#chat-list), under its project with the common chats, with a mark saying the Concierge started it. It also opens from the link on its row in the task list and from its task card, and search finds it.
- A task shows in a Concierge chat as one of two cards. Its **task card** names it with its status, a Stop and an Open: the Concierge shows it when it starts the task with a card, and when its owner looks for the task. Its **question or approval** shows alone, with no status, Stop or Open: the Concierge shows it while the task waits on its owner, and shows the one Rome says the task waits on, the newest open. Settled, it folds to a small card of what it asked and how it ended, and opens to the original. The message holds which task chat the card is for and the question or approval the task waited on when the card was said. Rome reads how that ended each time it hands the message out, and tells the chats that show it as soon as it settles. A card shows a task's question or approval only in its owner's own Concierge chat. In any other chat, and when its question or approval cannot be found, it shows one quiet line. It ended answered (with a short answer), dismissed, approved, rejected, turned down when the wait ran out or the task was stopped, or waiting on a newer copy. An app's own card, such as a sign-in, opens the task chat to answer it. A question or approval in any chat, a common chat's or the main agent's included, folds the same way once settled. The Activity page shows approvals whole. An expired question folds to a small card of what it asked that opens to its form: it still takes an answer, and counts as waiting nowhere. A card from before shows the task card with the question or approval inside.

## Task list

The list in a [Concierge chat](#concierge-chat)'s side panel that answers "what is my agent doing for me in this chat?". The dashboard labels it Tasks. It lists the chat's tasks, its checks, the follows whose alerts come to it, and the routines that work for it: those that send into it, and those made in it that send into no chat. Nothing else does. Its owner opens it from the agent's logo in the chat's header.

- It is its owner's only, like the chat: the guardian and each visitor see only their own chat's list, and a Stop on another person's chat is refused as if the chat did not exist. A common chat has none for now.
- It gathers what Rome already holds and decides nothing: a task shows its derived status, and a check, a schedule, a follow and a routine show as their own record says.
- Its rows fall into groups, one group each: **Needs you** (a task waiting on its owner), **Active** (a task at work, a scheduled task's run included), **Later** (a task with a check, a scheduled task between runs, and a check with no task), **Running on its own** (follows and routines), and **Ended** (done, failed, stopped and no-response tasks). Ended starts folded and shows the newest twenty, then more on request. A scheduled task moves between the groups run by run.
- Every row reads the same way: its title, then one line of its state and the time that goes with it, such as "Done · 2 hr ago" or "Daily at 3:47 PM · in 17 hr". A check for a task, a schedule, a follow's digest times, a paused routine and a failed last run all show on that line, never as a row or a mark of their own.
- A task with a task chat has a small link beside its title, the list's only way into that chat. Pressing a row does nothing.
- A task's row offers its owner what they can do to it, on hover: **Respond** on a task that needs them, which goes to the message in the chat that shows its question or approval, and **Stop** on every task that has not ended. Stopping a scheduled task ends its schedule. Either shows its effect at once, and neither asks to confirm. Checks, follows, routines and ended tasks have no buttons: they are changed by asking the Concierge, on the Routines page or in settings.
- A fired check and a deleted routine leave it, since neither has an outcome to show.
- It has no New button: recurring work starts by asking the Concierge, which makes a scheduled task.
- It changes as the work does, without being opened again.

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

- Widgets come from one shared catalog. Each kind has a name, what it holds, what people can do with it (answer, approve or deny, pick), and how each of those reads as plain text. Rome's own question and approval are kinds in it, beside the kinds apps add.
- Each platform draws the kinds it can as its own cards, and sends the plain-text line for the rest. Feishu draws a question as a card. Email sends it as text.
- A place's widget drawing is card or plain text.
- A widget's live state belongs to what it is about. An approval request shows as approved because the approval is.
- An agent shows a widget by calling a tool.
- A widget either asks something or only shows something. One that asks keeps the agent waiting until it is answered. One that only shows something leaves the agent to go on, and nobody answers it.
- An app's widget belongs to the app whose action showed it, and is one of the kinds that app adds. An action cannot show another app's widget.
- A widget is a message of its own, and is known by that message. A message that holds a widget holds nothing else (zhangfan, 2026-11-12).
- A widget's owner is the app that showed it, or Rome for its own kinds, such as the question. A widget keeps no state of its own: what it shows comes from its owner, read again when it is drawn and after each event.
- People do two things with a widget. An **edit**, such as picking an option or typing an answer, changes only what the widget shows on the screen in front of them. An **event**, such as pressing Send or a button that logs a glass of water, asks Rome to act, and carries the edits it needs. An edit never leaves the screen on its own.
- Every event goes to the widget's owner, which alone says what it means: an app's widget calls its app, and Rome's question answers the agent waiting on it. A widget accepts only the events it names, and only from someone who may open its chat.
- What the agent reads of an answer is written by Rome from the widget and the event. Anything the owner app adds reads as the app's, never as the words of the person who acted.

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
- **A New chat button, pinned chats and pinned projects at the top of the chat list.** They showed the same ideas twice beside the main chat, and a person had to choose between the Concierge and a new chat for every request. The main chat is where a person talks to Rome, and a common chat starts from Projects.
- **A task panel and a checks strip above the message box, beside the routines.** The same check showed on a task's row and in the strip, and a scheduled task was both a task and a routine, so the owner read one piece of work in up to three places. One task list per chat lists each piece once.
- **Cancel, skip, unfollow, pause and delete on the task list's rows.** Every row grew its own buttons, so the list read as a control panel rather than an answer to what runs. The Concierge chat, the Routines page and settings already change those, and the list keeps two buttons on a task's row: Respond and Stop.
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
- **The guardian sorting messages into chat threads.** It asks them to file every message by hand. Threads start only with a task.
- **A chat thread for any reply, named "Reply to …" when no task had it.** A reply to a plain answer opened a second, nameless kind of thread, and a message could sit in one task's thread while the Concierge sent it to another. One thread per task keeps a thread's name and its work the same.
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
