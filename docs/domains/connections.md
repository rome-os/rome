# Connections

What access Rome has to which external account.

## Connection

Rome's access to one external account: what the guardian gave so Rome can act or chat as that account. A bot token, the guardian's signed-in Telegram, the guardian's GitHub sign-in are each a connection.

- A connection has its own identity. Every connect makes a new connection, even to an account Rome reached before.
- A connection holds exactly one [grant](#grant), and the grant names the account it reaches. The connection reaches the same account for its whole life.
- At most one connection reaches an account at a time, across every kind of connection on that account's platform. Connecting an account Rome already reaches is refused.
- A connection is **working** or **broken**. It is broken when the platform stops accepting its grant, as when someone changes a Feishu app's secret. A broken connection keeps its account and that account's agent, and Rome does not hear or speak through the account until the connection is fixed.
- The guardian **connects** an account to give Rome access, **fixes** a broken connection by giving access again, and **disconnects** it to take the access away. Disconnecting ends the connection.
- A fix that comes back reaching another account is not refused, and it does not change the connection either: it ends this connection and starts a new one to the account that answered, in one step, and the dashboard says so (Ouou, 2026-11-04). The connection's account is immutable, so a send bound to a connection finds it or finds it gone, and never finds it reaching another account.
- There is no replacing one account with another on one connection. Whether the guardian disconnects and connects, or a fix lands on another account, the result is the same: one connection ended, a new one started.
- Connections never names an agent. Chats sees the account a connection lets Rome chat as, as a [connected account](chats.md#connected-account): the account, by its own identity, with the agent linked to it.
- When a connection is connected, Chats makes its connected account if it holds none for that account, with no agent. When it is disconnected, Rome stops hearing and speaking through the account, and nothing else is removed: the agent link stays on the account, and the chats keep their history, as the [chat](chats.md#chat) rule says: history belongs to the chat, not to the account that carried it.
- Connecting an account again after a disconnect reaches the same account, by platform and the platform's own id, through a new connection. The connected account is the same one, with the agent the guardian linked to it, and its earlier messages are still its own.
- Signing in to Rome, as the guardian does to open the dashboard with Google or GitHub, makes no connection and changes none, even when it reaches an account a connection holds ([ADR](../adrs/sign-in-links-separate-from-provider-connections.md)). Sign-in is outside this domain and is not modelled yet (Ouou, 2026-11-04).
- A working connection that lets Rome chat is how an account's messages reach Rome and how its agent's replies go back. There is no separate word for that plumbing.
- A connection is used in two ways. In chats, its grant lets Rome send and receive as the account, and then the account has one agent speaking through it (the rule under [Account](chats.md#account)). Outside chats, its grant lets Rome call the external system, as with GitHub, and then no agent is bonded to it: any agent, or Rome's own code, may use that access.

## Grant

The credential a connection relies on: a Feishu app's id and secret, a bot token, a signed-in session, an OAuth sign-in.

- A grant names the account it reaches: the platform and the platform's own id, as the platform reported them when access was given. A kind of connection with no platform, such as GitHub, names the account by the external system's own id for it.
- A grant may expire.
- A grant has no guardian-facing identity of its own. Core gives each grant an opaque epoch only so dependent access can stay bound to the authority the guardian gave Rome. Renewal keeps that epoch. Fixing or giving the grant again replaces the epoch and revokes dependent App access, even when the credential still reaches the same account.
- Grants are outside envoy and keep their current contracts ([Connections and grants](../adrs/channels-and-connectors-are-one-connection.md)).

## Connection kind

What the guardian picks when they connect: the kind of access they hand Rome. A Telegram bot, the guardian's signed-in Telegram, a Feishu app, a Discord bot, a Slack bot, email, WhatsApp and a GitHub sign-in are each a kind of connection.

- Each kind has its own setup flow and its own form of grant.
- What a connection lets Rome do is fixed by its kind: **chat** as the account, **act** on the external system, or **watch** it. The guardian never chooses it per connection.
- Each kind of connection belongs to one platform, and a platform may offer more than one kind. A Telegram bot and a signed-in Telegram user are two kinds on one platform. A Feishu app and a Lark app are two kinds on two platforms, whatever code they share.
- A kind of connection says how Rome got in. Where an account lives and who is who is the account's [platform](chats.md#platform), never its kind of connection.
- Some kinds have no platform, such as GitHub, since no chats live there.
- The Rome-managed Google kind reads Gmail without modifying, deleting or labeling mail. Every send needs the guardian's approval of that exact message, including its sender, recipients, subject and body. A schedule or another agent cannot approve a send on the guardian's behalf.
- The Rome-managed Microsoft kind reads Outlook mail the same way, without modifying, moving, deleting or flagging it, under the same approval rule for every send. Each send is a new message, never a threaded reply.
- The kinds ship with Rome. The guardian picks one, and never makes one.

## Watch

What a connection lets Rome hear from the external system without being asked: a review requested of the guardian, a CI run of theirs that failed, a new mail from a person.

- A connection that can watch says what can be watched through it: each source, the kinds of event there in the guardian's words, the options the guardian can state, and whose account the events concern, which is the connected account itself (the GitHub login, the mailbox address).
- Whether a source can be watched now is the connection's to say, with what is missing and how to fix it: not connected, no relay for events to reach Rome, no admin rights on a repository. Another connected app that cannot be watched says so too.
- The connection **normalizes** every raw event into one shape. It gives who, what, a link and a short excerpt. It says whether the guardian did it (`byYou`) and how it is addressed to them (`addressedTo`: `direct` when it is theirs or asks them, `copy`, or `other`). It adds labels, short words the connection chooses for what else it knows, such as `bot`, `mailing-list` or `ci-failed`. It drops only spam, trash and kinds the follower has off. Every difference between services ends here, so a new service changes only its connection.
- A connection's catalog declares the options a follower can store for each source, with their labels and values. They are the guardian's wishes, which a follower renders in words for whoever judges its events. They never filter events in code.
- Whether an event matters is not the connection's to say. The follower decides, from the generic fields and the labels. The Concierge's triage answers important, digest or ignore.
- Watching is something others use. It has no agent of its own. The Concierge's following is one user of it. A subscription at the external system, such as a repository's webhook, may serve several users at once, so one user stopping leaves the subscription in place.

## Device connection

What one of the guardian's devices lets Agents reach on it live, over rome-node: one capability of one device, such as Apple Health on the guardian's iPhone. Each capability of each device is its own connection, so turning one off leaves the others working.

**Two paths, one meeting point.** A capability on a device, such as Apple Health on an iPhone, reaches Rome in two ways:

```
          device capability (declared once, in the device's report)
           ├── sync ──► personal data   stored readings, per Rome and origin
           │                             read with core:personal_data_*, works while the device is away
           └── live ──► device connection  ask the device now
                                         read with core:device_describe / core:device_run

  personal data ──(not covered?)──► connection layer: which device, its state, the next step
```

- **Sync** is personal data's. The device pushes readings, Rome stores them, and Agents read them with no device online. Its switch is per Rome and origin: one install's sync to one Rome.
- **Live** is the device connection's. An Agent asks the device now, and it answers only while it is online and its Live access is on. Its switch is per device.
- **They meet in one place.** When the stored data does not cover a question, personal data asks the connection layer how to read it live: which device, its state, and the next step (a live read or a connect card). The dependency runs one way: personal data uses connections, and connections never read personal data. Neither stores the other's state. Which device a live read asks follows **The asking device answers** below.

- The device declares its capabilities: each one's title, command prefix, operations with read or write, and whether it is personal. Core stores what the device reports and names no capability itself, so a new capability needs no core change.
- Its grant is the device's own permission, such as the iOS permission for Health, and the device's Live access switch for that capability. A capability that needs no permission says so.
- A device connection is **working**, **off** (Live access is off) or **broken** (the device's permission is denied). Rome reads the state from the device's last report when asked, and stores none of its own.
- Offline is not broken. Rome keeps when the device last reported and never claims it is online: whether it answers shows only when an Agent asks it.
- A device connection holds only what live access needs, and the name of what its capability also syncs to, which it does not read. [Personal data](../personal-data.md) asks the connection layer which device connection reads the same data live, and never the reverse: a connection names its install's personal-data origin and the source its capability syncs to, reads neither, and neither stores the other's state. Screens that show both read both.
- The guardian connects a device connection on the device itself. A connect card in a chat leads there.
- Agents find device connections with `core:device_describe`, which lists each device's capabilities, operations, argument schemas and state from the device's last report and asks no device, and call one with `core:device_run`. An operation that writes, such as adding a calendar event, runs only in a private turn that the guardian's own message started, never one a routine, a followed event or another agent started, and only when the guardian asked for that change. A write that does not reach the device is not kept for later: the Agent says so and the guardian asks again with the Rome app open. A connection that is `off` or `broken` refuses before Rome calls the device and says what the guardian can turn on, and an offline device answers `target_unavailable` at once. How a capability is used lives in the device's own report, never in a prompt.
- **The asking device answers.** The Rome app names its device with each message the guardian sends, and a live read asks that device alone. When its connection is off, broken or missing, the Agent offers that device's connect card and never reads another device, since another row may be a different app install that is not running. A task chat the Concierge hands work to keeps the device the guardian asked from, so its live reads ask that device too. The connect card raised for the asking device checks that device's connection alone. The turn a card's answer starts asks the device it was pressed on, else the device the card was raised for, else the device the chat was last handed work from, and an approval's resume keeps the device its turn had. Only a turn no device started, such as one from the web, a routine or a scheduled task's run, takes a working connection, from a device that reported in the last 7 days. The Agent may name a device itself. Personal data and `core:device_run` both get this choice from the connection layer, and personal data never reads the device table.
- **A device id is one sign-in of one app install.** Its report names the install's personal-data origin, which stays the same across sign-ins, so Rome knows which install's data a device reads. Signing out reports no connections. Removing a device from the account through this Rome deletes its rows and turns its origin off when no other device id of that install still reports it, and its data stays. Rows leave no other way. A device whose last report is more than 7 days old is stale: it shows as stale and is never chosen, and its rows stay.

## Message

What a platform delivered through a connection: where it was said, who said it, what it says, whom it mentions and what it replies to, all in the platform's own ids. It is not the [message](chats.md#message) Chats records. Chats records its own from this one, at the one point where the two meet.

- A connection translates the platform's message and never decides anything from it. Whom it addresses, who the sender is to Rome and whether it wakes anyone are decided above the connection, in [Participation](participation.md#addressed) and People.
- It names the account it was delivered to, which is the connection's own account.
- Its mentions list only individual accounts. A mention of everyone, of a channel or of a role names no one.
- Some facts only the platform has, such as whether a bot said it or who said the message it replies to. The connection reports them when the platform tells, and leaves them out when it does not.
- Two of Rome's accounts in one chat each receive the same message through their own connection.

## Decided against

- **Giving tools direct access to the Google or Microsoft grant.** It would let a tool send mail without the guardian approving the exact message. Gmail and Outlook access stay behind the read-only and approved-send operations.
- **Outlook replies through Graph's reply endpoints.** They pick recipients from the original message, and `createReply` needs permission to change the mailbox, so the guardian could not approve exactly who receives the mail (2026-11-20).

- **The next connection of the same kind takes over the disconnected account's name, chats and history.** For an account that takes an agent, a new account is a new participant, and inheriting another account's history misattributes what was said.
- **Deleting a disconnected account's record, with the chats it alone was in.** The rule until 2026-11-04. The agent link is the guardian's decision about the account and outlives Rome's access to it, and a chat's history belongs to the chat whatever reaches it, so a disconnect removes Rome's reach and nothing else.
- **Keeping a disconnected connection, and reusing it when the same account is connected again.** A connection with no grant gives Rome no access, so it is not a connection. What carries over a reconnect is the account, by platform and the platform's own id, and the chats that kept its history.
- **Two connections to one account, each of its own kind.** A signed-in Telegram user and a Telegram bot for the same account would be two ways in to one participant, and the account could not say which one its agent speaks through.
- **Several grants on one connection.** Every kind relies on one credential, and a connection that holds several cannot say whether it is working.
- **Ending the connection when the platform stops accepting its grant.** A changed secret is not the guardian leaving. Ending it would take the account and its agent with it, and the guardian would have to connect and link again.
- **A connection that changes the account it reaches.** Everything that sends relies on the connection's account being true, and a connection that can change it leaves a window where a send chosen for one account goes out as another (#1614). The account is immutable. A fix that reaches another account ends the connection and starts a new one instead, so the guardian is never blocked.
- **The dashboard chat as a connection.** It reaches no external account and no access was given for it, so there is nothing to fix or disconnect. It is Rome's own chat. A visitor who signs in to it proves who they are, which gives Rome no access to act as anyone.
- **"Service" as the name for the kind of connection.** The code's word. It did not say what it was and read as a platform when it is not one, so a Telegram bot and a signed-in Telegram user as "two services" made no sense to the guardian.
- **A translation layer between the old vocabulary and the new.** That layer is for a context one cannot change, and Rome is one codebase its owners can change. It would add a second vocabulary to keep in step with the first. The code is refactored instead, each change landing as add beside, switch callers, remove.
- **A connection working out whom a message addresses.** Each connection did it its own way, and a group message heard by two of Rome's accounts carried one answer for both. The connection reports the facts, and Participation works the addressing out for each of Rome's accounts (Ouou, 2026-11-20).
- **"Platform message" for a connection's message, or a third "heard message" for one account's reading of it.** Each context has its own word "message". What one account makes of a message is a function of the message and the account, not a thing to name (Ouou, 2026-11-20).
- **The connection deciding whether an event concerns the guardian.** It dropped bulk mail, cc mail, bots and the guardian's own actions in code, which hid them from the one who decides, and every new service needed its own rules. Facts on the event let the follower decide.
- **Sync state on a device connection.** The first sketch kept sync on and off, and its state, in the connection's record. Sync belongs to personal data, whose source row already records it, and two records of one switch drift apart.
- **Each user of watching defining what can be watched.** The Concierge first listed GitHub event types and filtered mail itself. A second user would have repeated that, and the guardian would have met two names for one event and two answers to "can Rome watch this?".
- **How to use a device capability, written in prompt prose.** Each new capability, wording change or platform meant editing two prompts, and the Concierge, which has no shell, could not read a device at all. Capabilities come from the device's report, through actions (#2211).
- **Reading another device when the asking one cannot answer.** Another row may be a second app install that is not running: a live read went there, came back "device unreachable", and showed no connect card. The asking device answers, or its card shows.
- **Personal data reading the device table.** It worked out the state and picked the device itself, so every change to live reads changed personal data too. It asks the connection layer instead.
- **Deleting the rows a fetched device list leaves out.** Whether the list was whole was a guess, and a wrong guess deleted rows. Rows leave only by a removal through this Rome or a sign-out report.
- **The device id as the personal-data origin.** A device id changes at every sign-in, so each sign-in would start a new origin, with Health's history stored again beside the old copy and the earlier data left out of Delete. The report names the install's stable origin instead.
