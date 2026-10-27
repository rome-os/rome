# Connections

What access Rome has to which external account.

## Connection

Rome's access to one external account: what the guardian gave so Rome can act or chat as that account. A bot token, the guardian's signed-in Telegram, the guardian's GitHub sign-in are each a connection.

- A connection has its own identity. Every connect makes a new connection, even to an account Rome reached before.
- A connection holds exactly one [grant](#grant), and the grant names the account it reaches. The connection reaches the same account for its whole life.
- At most one connection reaches an account at a time, across every kind of connection on that account's platform. Connecting an account Rome already reaches is refused.
- A connection is **working** or **broken**. It is broken when the platform stops accepting its grant, as when someone changes a Feishu app's secret. A broken connection keeps its account and that account's agent, and Rome does not hear or speak through the account until the connection is fixed.
- The guardian **connects** an account to give Rome access, **fixes** a broken connection by giving access again, and **disconnects** it to take the access away. Disconnecting ends the connection.
- A fix must reach the same account. Access to another account is refused.
- There is no replacing one account with another. The guardian disconnects one and connects the other, and the new one starts fresh.
- Connections never names an agent. Chats sees a connection that lets Rome chat as a [connected account](chats.md#connected-account): the same connection, by the same identity, with its agent.
- When a connection is connected, Chats makes its connected account, with no agent. When it is disconnected, Chats removes the connected account, with the chats in which it was the only one of Rome's accounts and their history. A chat another of Rome's accounts is still in keeps its whole history, including the messages that reached Rome through the disconnected account alone, as the [chat](chats.md#chat) rule says: history belongs to the chat, not to the account that carried it.
- Connecting an account again after a disconnect reaches the same account, by platform and the platform's own id, through a new connection whose connected account has no agent. Its earlier messages in the chats that survived show as said by it again.
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

## Decided against

- **The next connection of the same kind takes over the disconnected account's name, chats and history.** For an account that takes an agent, a new account is a new participant, and inheriting another account's history misattributes what was said.
- **Keeping a disconnected account's record behind, retired.** The guardian has no use for a record nothing reaches, and the chat rule already says which history survives.
- **Keeping a disconnected connection, and reusing it when the same account is connected again.** A connection with no grant gives Rome no access, so it is not a connection. What carries over a reconnect is the account, by platform and the platform's own id, and the chats that kept its history.
- **Two connections to one account, each of its own kind.** A signed-in Telegram user and a Telegram bot for the same account would be two ways in to one participant, and the account could not say which one its agent speaks through.
- **Several grants on one connection.** Every kind relies on one credential, and a connection that holds several cannot say whether it is working.
- **Ending the connection when the platform stops accepting its grant.** A changed secret is not the guardian leaving. Ending it would take the account and its agent with it, and the guardian would have to connect and link again.
- **Fixing a connection with another account's access.** The account's agent, chats and history would move to an account that never said any of it.
- **The dashboard chat as a connection.** It reaches no external account and no access was given for it, so there is nothing to fix or disconnect. It is Rome's own chat. A visitor who signs in to it proves who they are, which gives Rome no access to act as anyone.
- **"Service" as the name for the kind of connection.** The code's word. It did not say what it was and read as a platform when it is not one, so a Telegram bot and a signed-in Telegram user as "two services" made no sense to the guardian.
- **A translation layer between the old vocabulary and the new.** That layer is for a context one cannot change, and Rome is one codebase its owners can change. It would add a second vocabulary to keep in step with the first. The code is refactored instead, each change landing as add beside, switch callers, remove.
