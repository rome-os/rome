# Channels

A [channel](../concepts/messaging.md#channels) is one service's conversation with a person. A service can carry more than a conversation. The same connection that carries messages can also let Rome act on the service. A service Rome only reads records from carries no conversation, and is not a channel however much of its data Rome holds.

Every channel answers the same three things. It carries messages, it says who it can reach, and it says what was said there. How much of each it can do is the channel's own answer, and a caller asks for it. What a channel cannot answer about its directory or its history is a limit of its platform, never a limit of what has been built.

## Statements

- Every channel receives messages.
- A channel sends messages when it reports that it sends.
- A channel reports what it can do. A caller asks the channel and never infers a capability from the channel's name.
- A caller reads every channel through one interface and names no channel. Adding a channel changes no code above it.
- A channel says who it can reach, as far as its platform offers a directory.
- A channel says what was said on it, as far back as its platform lets Rome read.
- A channel answers for what was said to a person and for what a conversation holds.
- A channel says who it reaches and what was said on it without its message transport.
- A person reachable several ways on one channel is one account with one history.
