# Concierge

How each person's Concierge talks with them in several [Concierge chats](../domains/chats.md#concierge-chat), hands work to [task chats](../domains/chats.md#task-chat), and sends each result, alert and digest to the chat that should hear it. What the Concierge follows, and how an event reaches it, is in [Concierge following](concierge-following.md). Why there is one Concierge with several chats is in the [ADR](../adrs/one-concierge-with-several-chats.md), and why each person has their own in [a Concierge for each person](../adrs/a-concierge-for-each-person.md).

## Flow

```mermaid
flowchart LR
    subgraph Shared["Shared by one owner's Concierge chats"]
        Memory["Memory<br/><i>every owner's</i>"]
        Follows["Follows<br/><i>each names one chat</i>"]
        Tasks["Task list<br/><i>each row names one chat</i>"]
        Rules["Digest times, quiet hours, time zone"]
    end
    Main["Main chat"]
    Topic["Topic chat"]
    TaskChat["Task chat"]
    Events["Followed events"]
    Digest["Digest"]

    Main -- starts --> TaskChat
    Topic -- starts --> TaskChat
    TaskChat -- result, question, approval --> Topic
    Events -- important --> Topic
    Events -- important --> Main
    Digest -- every chat's items, grouped --> Main
    Main -. reads, writes .-> Shared
    Topic -. reads, writes .-> Shared

    classDef chat fill:#EEEDFE,stroke:#534AB7,color:#3C3489
    class Main,Topic chat
```

Solid lines carry something said to the Concierge or by it. Dashed lines are what every chat reads and writes in common. A task chat started from the main chat reports to the main chat the same way.

## Invariants

### One Concierge, many chats

- **Every Concierge chat of one owner is the same Concierge.** Follows, the task list, digest times, quiet hours and time zone exist once per owner, and any of that owner's chats reads and changes them. Nothing about them is kept per chat except the chat each follow and each task row reports to. Memory exists once for every owner.
- **Each Concierge chat has its own transcript and its own agent session.** What is said in one chat is never in another chat's context. The Concierge reads another of its owner's Concierge chats only through its chat-reading tool, when a question needs it.
- **A rule written for "the Concierge chat" holds in every Concierge chat,** unless it names the main chat. No path checks for the main chat's id to decide behaviour another Concierge chat should share, such as quota failover or the model a resumed session restores.
- **Every Concierge turn's input opens with the chat it runs in:** its id, its name, and whether it is the main chat. It rides each turn, never the session's starting setup, so a rename reaches a running session.

### Each thing reports to one chat

- **A follow reports to one Concierge chat.** A new follow reports to the chat that asked for it. It moves only when a change names another chat, so following the same thing from a second chat answers where it reports and leaves it there.
- **A task row reports to the Concierge chat it was written in.** Its task chat's results, questions and approvals go there as task events, and the panel's buttons for the row send there.
- **A Concierge chat's task panel and its pill show that chat's rows only,** the main chat's included. There is no view of every chat's rows. A row moves to the main chat's panel when its chat is archived or deleted.
- **A Concierge turn's chat is decided when it is sent, in one place.** Alerts, digests, task events, recoveries and the wake-ups of `defer` all pass through it, and a chat that is archived or gone resolves to the main chat, so nothing waits on a chat the guardian closed and nothing stored is rewritten when one closes. A chat that never had a turn gets its runtime first, after the same quota check a message makes.
- **One chat's failed delivery never holds back another's.** Each chat's turn is kept owed and tried again on its own.
- **One delivery is one Concierge turn per chat.** A batch of important items or task events that spans chats becomes one turn in each, and each turn counts against the hourly cap of important turns.
- **The digest goes to the main chat only,** with every chat's items grouped under the chat they report to, so an item in a topic chat the guardian does not open is still read.

### The main chat stays

- **Each owner has exactly one main chat, and it is never archived or deleted.** The dashboard refuses both.
- **Archiving or deleting a topic chat moves its follows, its unfinished task rows and the events still owed to it to the main chat,** and the Concierge says so there. Restoring the chat moves nothing back. An archived topic chat is listed with the other archived chats, where it can be restored.
- **A topic chat starts on the model the main chat uses,** and keeps its own selection after that.
- **A topic chat started without a name is named from its first message, as an ordinary chat is.** One started with a name, and the main chat, keep theirs.

### Owners

- **The guardian and every visitor on the dashboard allow-list each have their own Concierge while it is on.** Each one's main chat is made the first time they open it. App users have none.
- **A Concierge chat, and every task chat it starts, answers as not found to anyone but its owner,** the guardian included, whether read, written, listed or searched, and whether reached by the chat's id or by the id of one of its turns or messages. A history read made from one person's chat leaves out every other person's Concierge and task chats.
- **Every Concierge turn's input names the person the chat serves,** right after the chat it runs in. Memory is shared and describes the guardian, so the Concierge never takes what it says as true of a visitor.
- **A visitor dropped from the dashboard allow-list is served nothing:** their events are not triaged or kept, and no alert, digest or task event reaches their chats. Their follows stay, and the next event after they are back on the list is served again.
- **Only a chat records its owner.** Follows and task rows reach their owner through the chat they report to, and a chat with no owner is the guardian's. A kept event also records its owner, so that one event is kept once per owner.
- **Triage runs once per batch for each owner,** with that owner's follows, what that owner was told recently and that owner's time zone. Two owners who follow the same thing each hear its events, and the subscription at the source stays while anyone follows it.
- **Quiet hours, the hourly cap of important turns and the digest are each owner's own.** One owner's quiet hours never hold another's alerts.
- **A Concierge turn acts only within its owner's Concierge:** the chats, task chats, rows and follows its tools reach are that owner's.
