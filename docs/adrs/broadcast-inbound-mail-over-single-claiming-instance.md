# Inbound mail is broadcast to every instance, not claimed by one

- **Status**: Accepted
- **Date**: 2026-08-11
- **Architecture**: [Channels](../architecture/channels.md)

## Context

An email address is an identity a correspondent saves and a human types. It belongs to the guardian's Rome, not to whichever machine backs it this week. So the address is [account](../concepts/rome-cloud.md)-scoped: one address, one provider inbox, derived from the account slug and stable across a repair or a reprovision. One account runs several [instances](../concepts/deployment.md#instances) under that one address — a desktop and a hosted box, or two devices — and each of them is a peer with the same claim on the account's mail.

Email is a [channel](../architecture/channels.md), and an inbound message reaches an instance over the webhook relay, the same path every other server-pushed delivery rides. Rome Cloud deposits into the instance's own relay mailbox, and the instance drains that mailbox over a connection it opens itself. A channel that holds its own provider connection, such as Telegram, never touches the relay. The relay path is store-and-forward by design. A desktop asleep for six hours is a normal recipient, not an absent one, and it collects its mail when it wakes.

Rome Cloud cannot see which instances are awake when it deposits. The relay exposes a deposit face and a drain face, and neither reports presence. The one liveness signal Rome Cloud holds is a last-seen stamp, bumped by the identity heartbeat every instance sends every fifteen minutes. That stamp says an instance answered recently, not that it is draining now, and a real presence check would need a new relay capability.

What Rome Cloud can see is ownership: an account's active linked instances, capped by a small per-account quota that defaults to three. The target set is therefore tiny by construction, and a deposit is one signature and a handful of cheap posts.

The judgment that matters is whether to answer the mail at all, and that judgment is the agent's. It runs on the instance, against the memory and conversation context that instance holds. Two instances of one account do not hold the same context, and no central service can decide for them.

The industry default for several workers on one shared mailbox runs the other way. Competing consumers take an exactly-once claim or lease per message, precisely so a correspondent never receives two answers. That default is already re-proposed inside Rome: the non-goals of account-scoped mail turn back a claim or lease, a primary-only reply, and a presence-filtered fan-out. Each of them is the obvious first suggestion a reader brings to the design.

## Decision

Rome Cloud deposits an inbound message into the relay mailbox of every one of the account's active linked instances, with no leader, claim, lease, liveness check, or cross-instance dedup. Each instance dedupes only against itself, keyed on the provider message id, and decides on its own whether to reply.

## Alternatives

- **Claim or lease the message so exactly one instance handles it, the competing-consumers default.** Rejected because a claim is only safe when the claimer is known to be alive, and no signal Rome Cloud holds proves that at deposit time. A sleeping desktop that wins the claim strands the mail until the lease expires, which converts a normal offline instance into hours of delay for the correspondent.
- **Designate one primary instance as the only replier and give the rest read-only copies.** Rejected because the account's instances hold different context, so the primary is often the one machine that lacks the thread the mail belongs to. The role also needs failover semantics, which reintroduces the liveness question that has no answer here.
- **Deposit only to instances the relay reports as connected.** Rejected because store-and-forward delivery treats an offline instance as a recipient that has not drained yet, so a presence filter silently drops mail for the guardian's own sleeping laptop. It also needs a relay presence capability that does not exist, and the fifteen-minute last-seen stamp is far too coarse to stand in for one.
- **Have Rome Cloud mark a message handled once one instance ingests it, so peers skip it.** Rejected because ingestion is not an answer, and Rome Cloud sees only the deposit. The check would put per-message processing state in a deposit path that today holds none, and it would suppress the second instance in exactly the case where the first one decides to stay silent.
- **Route each thread to the single instance that owns it, chosen by the last replier.** Rejected because per-thread routing state in Rome Cloud binds a durable correspondence to one machine, and it breaks the moment that machine is retired. Surviving instance replacement is the reason the address became account-scoped.
- **Keep one address per instance so every conversation has exactly one recipient.** Rejected because the address must outlive the instance, and a reprovision orphans an address a correspondent already saved. Several instances under one account slug also collide on the shared address, since the provider hands back one inbox per account.
- **Treat every relay mailbox row the account ever minted as the target set.** Rejected because the mailbox ledger is retained for audit after an instance is revoked, so deposits pile into buffers no instance drains and a dead instance keeps consuming the account's quota. Linked-instance mailbox ownership narrowed the target set to mailboxes owned by an active linked instance and kept the rest of this record intact.

## Consequences

The deposit path stays stateless. Rome Cloud resolves the account from the inbound address, signs the event once with the account-level secret, and posts it to each target. There is no leader election, no lease table, and no per-message bookkeeping. Retries come from the sender's own redelivery and from the relay mailbox replaying what an instance has not acknowledged, never from the deposit path. Linking or revoking an instance changes the target set on its own, with no mail-side coordination. Any instance can answer in the right thread, because the deposited event carries the provider thread id and message id a reply needs.

The cost lands on the correspondent and on the guardian. Two instances that both decide to answer produce two replies from the same address in the same thread, and nothing in the system prevents that — the agent's judgment is the only arbiter. An instance that was offline can drain an old message and act on it, so freshness is an instance-side concern. The inbound secret is account-level and shared by every instance, so it authenticates the account rather than one sender. Nothing central records which instance answered a given message, so outbound attribution needs a marker added at send time.

Future diffs must respect:

- One inbox per account. The address derives from the account slug and survives instance replacement.
- Deposit reaches every active linked instance's mailbox. Narrowing the target set on ownership is allowed, as linked-instance ownership did. Narrowing it on liveness, presence, or recency reopens this record.
- No claim, lease, leader, or primary instance in the inbound path. An instance never waits on a peer before acting.
- Dedup stays per-instance and keys on the provider message id the deposit carries. Rome Cloud holds no cross-instance processing state.
- Two instances handling one message is the intended behavior, and a duplicate reply is an accepted cost rather than a bug to fix at the deposit path. Coordination, if it ever arrives, lands on the instance or in the agent, and it is additive.
- A change that needs to know which instances are online needs a relay presence capability first, and its own decision record.
