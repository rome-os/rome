# Instance

Which Rome this is, and whether it is up to date and healthy. Instance knows the Rome it runs as and the Rome Cloud it belongs to. Who may use this Rome belongs to Access, and what runs on it belongs to the other contexts.

## Instance

One running Rome, the guardian's. It is known by its slug, a short name that stays the same for its whole life and is part of its address.

- Two instances are the same instance when they have the same slug.
- An instance runs on the guardian's own machine or is hosted by Rome Cloud. A hosted instance gets its slug from Rome Cloud, never from whoever set it up.
- The slug and the address do not change while the instance runs.

## Rome Cloud

The service that hosts instances, ships their releases, and vouches for them to others.

- An instance belongs to at most one Rome Cloud, fixed when the instance starts.
- An instance on the guardian's own machine may have no Rome Cloud. It then runs on its own and reaches nothing that goes through Rome Cloud.

## Enrolled

The state of an instance that Rome Cloud knows and vouches for. Rome uses it whenever it asks Rome Cloud for something on the instance's behalf.

- The guardian **enrolls** an instance on their own machine by signing in to Rome Cloud from it. Rome Cloud **adopts** a blank hosted instance by handing it its identity, and an adopt that does not come from Rome Cloud is undone and refused.
- Rome checks that the instance is still enrolled when it starts, and again at a fixed interval while it runs. It stops being enrolled as soon as Rome Cloud disowns it.
- Rome never renews or restores an enrollment on its own. Only the guardian enrolls again.
- When Rome checks, Rome Cloud names the Rome Cloud account the instance is enrolled under. Rome keeps that account as Rome Cloud sends it.

## Signup answers

What the guardian told Rome Cloud when signing up, before the instance existed. The first sign-in from Rome Cloud turns them into the guardian's name and the agent's name, a short note in memory, and, when the guardian asked Rome to follow a service, one message to the Concierge.

- Missing or partial answers set up nothing and are never an error.

## Release

The version of Rome an instance runs.

- An instance knows when it starts on a different release than the one it last started on.

## Upgrade

Moving an instance to a newer release. The instance asks, and Rome Cloud carries it out.

- Each night Rome asks Rome Cloud whether a newer release is waiting, where automatic upgrades are turned on for the instance. When one is, Rome **offers** it with a countdown.
- During the countdown the guardian **upgrades now** or **defers**. When the countdown ends with no answer, Rome upgrades: silence is consent.
- The countdown is kept by the instance, not by a dashboard, so it ends even when no dashboard is open.
- An upgrade restarts Rome. An upgrade that fails goes back to the release that ran before.

## Health

What the instance reports about itself: its release, how long it has run, whether its database answers, how its apps are doing, and its memory and disk.

- Memory and disk are each marked low against one threshold. A reading the machine does not offer is left out, never guessed.
- A diagnosis also asks Rome Cloud whether the instance is still enrolled.

## Decided against

- **Link for the state of being known to Rome Cloud.** Link already means an agent on an account in Chats and an account's person in People. A third meaning would make every sentence about it ambiguous.
- **Who may use this Rome inside Instance.** Sign-in, sessions and visitors change for each person who comes to the dashboard, while Instance changes only when the instance itself does.
