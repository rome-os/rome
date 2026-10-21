# Connections

What access Rome has to which external account.

## Connection

Rome's access to an external account: what the guardian granted so Rome can act or chat as that account. A bot token, the guardian's signed-in Telegram, the guardian's GitHub sign-in are each a connection.

- The guardian **connects** an account to give Rome access and **disconnects** it to take the access away.
- There is no replacing one account with another. The guardian disconnects one and connects the other, and the new one starts fresh.
- Disconnecting an account removes its record, and removes the chats in which it was the only one of Rome's accounts, with their history. A chat another of Rome's accounts is still in keeps its whole history, including the messages that reached Rome through the disconnected account alone, as the [chat](chats.md#chat) rule says: history belongs to the chat, not to the account that carried it.
- The fresh-start and removal rules cover accounts that take an agent. An account that takes none, such as email or WhatsApp, keeps its record and history across a reconnect, as [Account](chats.md#account) says.
- A connection with a chat grant is how an account's messages reach Rome and how its agent's replies go back. There is no separate word for that plumbing.
- A connection is used in two ways. In chats, its grant lets Rome send and receive as the account, and then the account has one agent speaking through it (the rule under [Account](chats.md#account)). Outside chats, its grant lets Rome call the service, as with GitHub, and then no agent is bonded to it: any agent, or Rome's own code, may use that access.

## Grant

One act of giving Rome access, and what it allows: chatting, acting, watching.

- Grants are outside envoy and keep their current contracts ([Connections and grants](../adrs/channels-and-connectors-are-one-connection.md)).

## Decided against

- **The next connection of a service takes over the disconnected account's name, chats and history.** For an account that takes an agent, a new account is a new participant, and inheriting another account's history misattributes what was said.
- **Keeping a disconnected account's record behind, retired.** The guardian has no use for a record nothing reaches, and the chat rule already says which history survives.
- **A translation layer between the old vocabulary and the new.** That layer is for a context one cannot change, and Rome is one codebase its owners can change. It would add a second vocabulary to keep in step with the first. The code is refactored instead, each change landing as add beside, switch callers, remove.
