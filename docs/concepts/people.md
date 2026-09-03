# People: Guardian, Visitor, Persons, Accounts, Addresses, Links & Outbox

## Guardian

The guardian is the single human user that a Rome instance serves. They control all configuration, memory, and policies. The guardian's profile (name, timezone, preferences) is stored in [memory](data.md#memory).

**Contracts:**

- One Rome instance serves exactly one guardian. There is no multi-guardian mode.
- The guardian is always the highest-trust [bond level](#bond-levels). No person can outrank them.
- Only the guardian can approve or reject an [approval-gated action](messaging.md#approvals).
- The guardian's full access is inherent. Every other authenticated caller is a [visitor](#visitor) whose access is granted and revocable.

**Not to be confused with:**

- **[Person](#person)** — a person is someone the guardian knows. The guardian is the one the instance serves.
- **[Visitor](#visitor)** — a visitor holds scoped access the guardian granted. The guardian owns the instance and can never be outranked by one.
- **The agent's identity** — the agent has its own name and personality, stored separately from the guardian's profile.

## Visitor

A visitor is the holder of a [Rome Cloud](rome-cloud.md) account that the guardian has granted scoped access to. A visitor authenticates by signing in to that account — the sign-in flow and its edge enforcement live in [access control](../architecture/access-control.md).

**Contracts:**

- A visitor reaches only the surfaces its email is allow-listed for: individual access-gated apps, or the full dashboard when the guardian keeps a dashboard allow-list. A visitor can never hold guardian privileges.
- The visitor's email is authoritative from the Rome Cloud sign-in exchange. Nothing the browser supplies can set or change it.
- Every request re-checks allow-list membership, so removing an email revokes access immediately rather than at the next sign-in. The email comparison is case-insensitive.

**Not to be confused with:**

- **[Guardian](#guardian)** — the guardian owns the instance and holds full access. A visitor holds scoped access the guardian granted.
- **[Person](#person)** — a person is someone the guardian knows, carrying a bond level. A visitor is an authenticated caller, and the two are orthogonal — a visitor need not be a tracked person.

## Person

Rome tracks people the guardian knows. Each person carries a [bond level](#bond-levels) that determines how the system interacts with them. [Links](#link) to multiple [accounts](#account) let the system recognize the same person across [channels](messaging.md#channels).

**Contracts:**

- A person is channel-independent: multiple linked accounts resolve to the same person, and what the system knows about someone travels with the person, not with any account.
- Every person carries exactly one [bond level](#bond-levels).

**Not to be confused with:**

- **[Guardian](#guardian)** — the guardian is served by the instance. Persons are known to it.
- **[Account](#account)** — an account is a party on one platform. A person aggregates the accounts linked to them.

## Account

An account is a party on an external messaging platform — a Telegram user, a WhatsApp number, a LinkedIn profile. The platform owns the account, and Rome only observes it. Deprecated alias: *platform identity*.

**Contracts:**

- An account is identified by its [channel](messaging.md#channels) plus its own [address](#address). The same pair always names the same account.
- Rome never creates or deletes an account. Platforms own the account lifecycle, and Rome learns of accounts from inbound messages.
- An account resolves to a person only through its [link](#link). An account with no link resolves to no one.
- An account is in exactly one of three states: unlinked, linked, or dismissed. Dismissal records that the account belongs to no one the guardian tracks. A dismissed account stays out of discovery until the guardian restores or links it.
- The state is derived from the account's link. No surface stores or reports a state that can disagree with the link behind it.
- The guardian's own accounts on a platform are accounts like any other, linked to the guardian.

**Not to be confused with:**

- **[Person](#person)** — Rome owns persons, and platforms own accounts. A person aggregates the accounts linked to them.
- **[Address](#address)** — an account is the party. An address is one of the forms it is reachable at.
- **[Channel](messaging.md#channels)** — a channel is the platform integration messages arrive through. An account is one party on that platform.
- **Connection** — a connection joins the Rome instance to a service. An account belongs to a party on that service.

## Address

An address is a form an [account](#account) is reachable at on its [channel](messaging.md#channels) — a phone number, a member id, a mailbox. The platform owns the form and Rome carries it whole. Deprecated alias: *channel user id*.

**Contracts:**

- An address is opaque. No surface parses, constructs, or compares parts of one, so a platform can change the form it hands out without any reader changing.
- Every address a channel can receive a message on resolves to exactly one account. One account reachable under several addresses is one account, never two.
- Exactly one of an account's addresses is the account's own — the one a [link](#link), a dismissal, or a stored message names it by. Which one is the channel's answer, not a rule any reader derives.
- An address names an account, never a person. Who is behind it is the account's [link](#link).

**Not to be confused with:**

- **[Account](#account)** — the account is the party, stable across every address it answers to. An address is one form of reach.
- **Identifier** — an identifier is a searchable fact about an account, such as an email or a profile URL. An address is what a message is addressed to, and a searchable fact is not one.

## Link

A link is the recorded fact that an [account](#account) belongs to a [person](#person). It is the only fact about who is who that Rome adds to what the platforms provide. Deprecated alias: *channel mapping*.

**Contracts:**

- A link joins exactly one account to exactly one person. There is no ownerless or dangling link.
- An account carries at most one link, so two persons can never hold the same account.
- Sender attribution changes only by creating, destroying, or transferring a link, or by dismissing or restoring the account. A transfer between two persons is always an explicit operation, never a side effect of another one.
- A link applies retroactively: creating one attributes the account's entire message history to the person, and destroying one detaches that history.

**Not to be confused with:**

- **[Bond level](#bond-levels)** — a bond level grades trust in a person. A link attributes an account to a person.
- **Connection** — a connection joins the Rome instance to a service. A link joins an account to a person.

## Outbox

The outbox holds messages Rome has been asked to send and has not yet seen arrive. A message leaves it by appearing on the recipient's [timeline](#account). Nothing marks one delivered.

**Contracts:**

- A send names the [account](#account) it is for. Rome never chooses one on the guardian's behalf, on any evidence: a timeline entry names its channel and not its address, so no rule can tell two accounts on one channel apart, and reaching for a second channel when the first is down delivers somewhere nobody picked. A surface may preselect an account, and must show which one it picked.
- A channel can be sent to only if it says so. `talk.feature("directMessaging")` answering null is the whole declaration, so a channel Rome mirrors but cannot write to needs no flag of its own.
- An outbox row is exactly a send whose message is not on the timeline yet. It is derived from that comparison rather than cleared by anything, so no delivery callback can be missed and the two reads cannot disagree.
- A message is recognized as arrived by the id the channel gave back, never by its text or its timing. A channel offering direct messaging must return one.
- A failed send stays until the guardian retries it or discards it. A retry reuses the row, so it never reads as a second message they did not write.

**Not to be confused with:**

- **Timeline** — a timeline entry is a message that happened. An outbox row is one that has not, and may never.
- **[Link](#link)** — a link says who an account belongs to. An outbox row is addressed to the account itself, so a merge moving the link leaves it true.

## Bond levels

A bond level is the trust tier assigned to a [person](#person). It determines how deeply the system remembers them and whether their messages are trusted by default.

| Level | Examples | Memory depth |
|---|---|---|
| Guardian | You | Full profile |
| Inner circle | Family, close friends | Detailed profile |
| Acquaintance | Colleagues, contacts | Moderate profile |
| Other | Everyone else | Name only |

**Contracts:**

- Bond level drives the default routing for a sender's messages: trusted levels route direct to the main agent, and everyone else goes through [sentinel](messaging.md#sentinel) triage. By default only the guardian is trusted. Which levels count as trusted is configurable.
- [Policies](messaging.md#policies) can override the default routing per sender, thread, or channel.
- The guardian tier is fixed as the highest-trust level.

**Not to be confused with:**

- **[Policy](messaging.md#policies)** — a bond level is an attribute of a person. A policy is a routing rule that may key on bond level (among other things).
