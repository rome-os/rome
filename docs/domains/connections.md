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
- The kinds ship with Rome. The guardian picks one, and never makes one.

## Watch

What a connection lets Rome hear from the external system without being asked: a review requested of the guardian, a CI run of theirs that failed, a new mail from a person.

- A connection that can watch says what can be watched through it: each source, the kinds of event there in the guardian's words, the options the guardian can state, and whose account the events concern, which is the connected account itself (the GitHub login, the mailbox address).
- Whether a source can be watched now is the connection's to say, with what is missing and how to fix it: not connected, no relay for events to reach Rome, no admin rights on a repository. Another connected app that cannot be watched says so too.
- The connection **normalizes** every raw event into one shape. It gives who, what, a link and a short excerpt. It says whether the guardian did it (`byYou`) and how it is addressed to them (`addressedTo`: `direct` when it is theirs or asks them, `copy`, or `other`). It adds labels, short words the connection chooses for what else it knows, such as `bot`, `mailing-list` or `ci-failed`. It drops only spam, trash and kinds the follower has off. Every difference between services ends here, so a new service changes only its connection.
- A connection's catalog declares the options a follower can store for each source, with their labels and values. They are the guardian's wishes, which a follower renders in words for whoever judges its events. They never filter events in code.
- Whether an event matters is not the connection's to say. The follower decides, from the generic fields and the labels. The Concierge's triage answers important, digest or ignore.
- Watching is something others use. It has no agent of its own. The Concierge's following is one user of it. A subscription at the external system, such as a repository's webhook, may serve several users at once, so one user stopping leaves the subscription in place.

## Decided against

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
- **The connection deciding whether an event concerns the guardian.** It dropped bulk mail, cc mail, bots and the guardian's own actions in code, which hid them from the one who decides, and every new service needed its own rules. Facts on the event let the follower decide.
- **Each user of watching defining what can be watched.** The Concierge first listed GitHub event types and filtered mail itself. A second user would have repeated that, and the guardian would have met two names for one event and two answers to "can Rome watch this?".
