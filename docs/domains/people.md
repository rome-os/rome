# People

Who is behind an account, and how close they are to the guardian. People follows the definitions of [platform](chats.md#platform) and [account](chats.md#account) in Chats and changes neither. [Participation](participation.md) asks People one question about a sender, [who is this](#who-is-this), and People never decides what happens to a message.

## Person

Someone the guardian knows: an entry in their phone book. The guardian is one of the people.

- Two persons are the same person when they are the same entry. Nothing on a platform makes two persons one. Only the guardian does, by merging them.
- A person exists from the moment the guardian creates them, by name or from an account. They stop existing when the guardian deletes them or merges them into another.
- The guardian **creates**, **renames**, **merges** and **deletes** a person. A merge makes two persons one, and the links of the one that goes move onto the one that stays.
- Deleting a person returns their accounts to strangers. Every chat keeps its history, since [history belongs to the chat](chats.md#chat).
- Every person has exactly one bond level.
- An agent is not a person. An agent delegated by a person acts on that person's behalf, as [Delegate link](#delegate-link) says.

## Guardian

The one person Rome serves. A person like the others, with the highest bond level, which no one else can hold.

## Bond level

How close a person is to the guardian: guardian, inner circle, acquaintance, other. Other is someone the guardian tracks but keeps at arm's length.

- A bond level grades a relationship, so only a person has one. An account with no person behind it has no bond level. It is a stranger or dismissed, never other.
- What a level means for how Rome answers someone and how much it remembers about them is not part of this language. It keeps the contracts in [bond levels](../concepts/people.md#bond-levels).

## Account

A participant's identity on a platform, as [Account](chats.md#account) in Chats defines it: the platform plus the platform's own id. Here it is the thing a person is behind.

- A person can have many accounts: one on each platform they use, and more than one on the same platform. A work and a private Telegram are two accounts of one person.
- One account is one account to every one of Rome's accounts on its platform. A colleague writing to the Sales account and to the guardian's own signed-in account from the same Telegram is one account, not two.
- Rome never makes an account. It learns of one when a message arrives or an address book is read, and the platform owns it from then on.
- An account is in one of three states. A **stranger** is one nobody has decided about. A **linked** account belongs to a person. A **dismissed** account is one the guardian decided belongs to nobody they track.
- The guardian **links** an account to a person, **moves** it to another, **unlinks** it, **dismisses** it, and **restores** a dismissed one to a stranger.
- Dismissing makes no person. The guardian sometimes does not know who a stranger is, and a person for every stranger is too much work.
- An account linked to the guardian is one of theirs. The guardian's signed-in accounts, such as their own Telegram, WhatsApp, LinkedIn, WeChat or email, are theirs the moment they connect them, with no further step.
- Where the platform does not say which account is the guardian's, the guardian links their account to themselves like any other. A code Rome shows them, sent in a direct message to any of Rome's accounts, is a shortcut for finding it. It works the same on every platform.

## Link

The fact that an account belongs to a person. It is the only fact about who is who that Rome adds to what the platforms say. In Chats, link is the verb for putting an agent on an account, a different link in a different context.

- One account has at most one link, so no account belongs to two persons.
- A link is made only by the guardian, or from a statement the platform makes about which accounts are the guardian's. Never from what a sender says about itself, such as a display name.
- A link reaches back. Linking attributes everything the account ever said to the person, and unlinking takes it away again.
- Moving an account from one person to another is always the guardian's explicit act, never a side effect of something else.
- A link outlives Rome's access. Disconnecting the last of Rome's accounts on a platform removes nothing from People, and connecting again later finds everyone already known.

## Delegate link

A link that says the account is an agent's, acting on behalf of the person it is linked to. A [delegate](chats.md#delegate) in Chats is an agent answering from the guardian's own account. A delegate link is the other way round: an agent's own account, attributed to the person behind the agent.

- An agent's account belongs to the person who delegated the agent, never to the agent itself.
- The link says it is a delegate, so whoever reads it knows they are talking to someone's agent and not to the person.
- Rome makes this link itself when the platform says the agent is the guardian's. Rome Cloud says so for the guardian's own agents on other Romes. The guardian links anyone else's agent as they would any account.

## Stranger

An account nobody has decided about yet. A stranger waits for the guardian to link or dismiss it.

- Rome does not ask a stranger to do anything. Whether a stranger's message is answered, triaged or dropped is the reply rule's and the sentinel's business, not People's.

## Who is this

The one question Participation asks People about a sender. The answer is a person with their bond level, or nobody.

- A stranger and a dismissed account both answer nobody. The difference matters only to the guardian, in which accounts are shown for them to decide about.

## Decided against

- **Pairing, a step a sender takes to be heard.** Its one job was linking the guardian's own account. The link verb already does that. Blocking an unknown sender until the guardian approves it made the guardian a stranger to their own agents.
- **A fifth bond level, stranger, for accounts with no person.** A level grades a relationship. Nobody knows who the account is, so there is no relationship to grade.
- **A person made for every dismissed account.** The guardian often does not know who a stranger is. Dismissing is a decision about the account, not a new entry in the phone book.
- **An agent as a person of its own.** An agent acts for whoever delegated it. A reply needs to know it is talking to someone's agent, and a person of its own hides that.
- **The routing policy inside People.** People answers who a sender is. What happens to the message keys on that answer and belongs to the reply rule and the sentinel.
- **Links that go when Rome's access goes.** A link is a fact about who is who, not about Rome's access. Losing it on a disconnect made the guardian a stranger again on the next connect.
- **An account per kind of connection.** A signed-in Telegram user and a Telegram bot see the same person by the same id. Splitting them by how Rome got in made one account two.
