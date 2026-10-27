# People: Guardian, Visitor, Persons, Accounts, Addresses, Links & Sending

What person, guardian, bond level, account, link and stranger mean is in the [People](../domains/people.md) domain language. This page holds the engineering contracts behind those words, and the words of its own: visitor and address.

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
- Each sign-in keeps the visitor's email and Rome Cloud picture in `visitor_profiles`, replacing the last one. Chat reads it to show who sent a message, so it is display only and never authenticates anyone.

**Not to be confused with:**

- **[Guardian](#guardian)** — the guardian owns the instance and holds full access. A visitor holds scoped access the guardian granted.
- **[Person](#person)** — a person is someone the guardian knows, carrying a bond level. A visitor is an authenticated caller, and the two are orthogonal — a visitor need not be a tracked person.

## Person

Rome tracks people the guardian knows. Each person carries a [bond level](#bond-levels) that determines how the system interacts with them. [Links](#link) to multiple [accounts](#account) let the system recognize the same person across Rome's own [accounts](../domains/chats.md#account).

**Contracts:**

- A person is channel-independent: multiple linked accounts resolve to the same person, and what the system knows about someone travels with the person, not with any account.
- Every person carries exactly one [bond level](#bond-levels).

**Not to be confused with:**

- **[Guardian](#guardian)** — the guardian is served by the instance. Persons are known to it.
- **[Account](#account)** — an account is a party on one platform. A person aggregates the accounts linked to them.

## Account

An account is a party on an external messaging platform — a Telegram user, a WhatsApp number, a LinkedIn profile. The platform owns the account, and Rome only observes it. Deprecated alias: *platform identity*.

**Contracts:**

- An account is identified by its [channel](../architecture/channels.md) plus its own [address](#address). The same pair always names the same account.
- Rome never creates or deletes an account. Platforms own the account lifecycle, and Rome learns of accounts from inbound messages.
- An account resolves to a person only through its [link](#link). An account with no link resolves to no one.
- An account is in exactly one of three states: unlinked (a [stranger](../domains/people.md#stranger)), linked, or dismissed. Dismissal records that the account belongs to no one the guardian tracks. A dismissed account stays out of discovery until the guardian restores or links it.
- The state is derived from the account's link. No surface stores or reports a state that can disagree with the link behind it.
- The guardian's own accounts on a platform are accounts like any other, linked to the guardian.

**Not to be confused with:**

- **[Person](#person)** — Rome owns persons, and platforms own accounts. A person aggregates the accounts linked to them.
- **[Address](#address)** — an account is the party. An address is one of the forms it is reachable at.
- **[Account in Chats](../domains/chats.md#account)** — the domain language names every identity on a platform an account, Rome's own included. An account here is one party Rome sees through one of its own.
- **Connection** — a connection joins the Rome instance to a service. An account belongs to a party on that service.

## Address

An address is a form an [account](#account) is reachable at on its [channel](../architecture/channels.md) — a phone number, a member id, a mailbox. The platform owns the form and Rome carries it whole. Deprecated alias: *channel user id*.

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
- Rome never creates a link from what a sender says about itself, such as a display name. A sender sets its own name, so an unlinked account whose name matches a person stays unlinked until the guardian links it.
- Rome creates a link on its own only from a statement a platform makes about the guardian's own accounts. On the Agents channel, Rome Cloud marks a sender that is in this Rome's Cloud account, and Rome links that agent to the guardian when its first message arrives. Rome makes this link at most once per agent, and never over an existing link or a dismissal, so a guardian who unlinks or dismisses the agent keeps it that way.
- A link applies retroactively: creating one attributes the account's entire message history to the person, and destroying one detaches that history.

**Not to be confused with:**

- **[Bond level](#bond-levels)** — a bond level grades trust in a person. A link attributes an account to a person.
- **Connection** — a connection joins the Rome instance to a service. A link joins an account to a person.

## Sending

A send names its account and Rome's account, and fails loudly. It is one call to the channel, answered in the request: the channel took the message, or the channel refused it and the request says why. A message the channel took joins the [timeline](#account) once the store that answers for its conversation holds it. Rome records its own copy before answering, and a channel with a mirror of its own answers for the conversation with the mirror's copy, which may land after the send answered, so a client keeps reading the timeline while it is open. Rome keeps no record of a send beyond that copy, so a refused send is the client's to retry or drop.

**Contracts:**

- A send names the [account](#account) it is for. Rome never chooses one on the guardian's behalf, on any evidence: a timeline entry names its channel and not its address, so no rule can tell two accounts on one channel apart, and reaching for a second channel when the first is down delivers somewhere nobody picked. A surface may preselect an account, and must show which one it picked.
- A send leaves no doubt about either end. It names the person's account it goes to, and `from` names which of [Rome's accounts](messaging.md#romes-accounts) it goes out from. `from` names Rome's account by its platform and the platform's own id, as any account is named. The person read lists, as `from` on each account, Rome's accounts on that account's platform that can be named. A `from` that is not among them is refused, and Rome never substitutes another account for it.
- Rome never picks among its own accounts on one platform. A link keys an account by its platform, so a send that names no `from` goes out only while Rome holds exactly one account on that platform that can send. While Rome holds several, the account reads as sendable, since a send may name any of them, but a send that names none is refused as `not-connected`. The account's timeline reads its conversations with every one of Rome's accounts on the platform. A send without `from` stays accepted only until the dashboard names it on every send.
- A channel can be sent to only if it says so. Its `send` port's `direct` answering null is the whole declaration, so a channel Rome mirrors but cannot write to needs no flag of its own.
- A send that cannot go out is refused before the channel is called, with a 409 naming why (`SendRefusal`). A send the channel refuses answers 502 with the channel's own words. A send the channel took answers 200, even when Rome then fails to record its copy, since the message went out and a retry would send it twice.
- There is no idempotency key. A client that lost the answer to a send cannot tell whether it went out, and a retry may send it twice. Delivery guarantees come back with Chats.

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
