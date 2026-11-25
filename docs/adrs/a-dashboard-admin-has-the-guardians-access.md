# A dashboard admin has the guardian's access, with four exceptions

- **Status**: Accepted
- **Date**: 2026-11-24
- **Concept**: [People — Team](../concepts/people.md#team), [Access control](../architecture/access-control.md)
- **Supersedes**: the sentence "Approvals stay with the guardian" in [A Concierge for each person](a-concierge-for-each-person.md)

## Context

A guardian who invites people to the dashboard wants them to use Rome as the guardian does. A [dashboard admin](../concepts/people.md#dashboard-admin) reached most of the dashboard, but every check that asked for the guardian refused them: approvals, the vault, app-connection access, personal data, device connections, the app catalog stream, and the node console. Each of those checks was written on its own, so the guardian could not tell from Settings what a person they invited could do.

## Decision

The guardian and every dashboard admin are the [team](../concepts/people.md#team). Every dashboard check that admitted only the guardian admits the team instead, and asks Access one question: whether the session actor is on the team, read from the dashboard allow-list as it stands at the request.

Four things stay the guardian's alone:

- Billing for the instance.
- Deleting the instance.
- Removing or replacing the guardian's seat or its credentials. A dashboard admin uses the vault, but never resets it, because a reset deletes every secret and replaces the PIN.
- What is the guardian's own person: their detected time zone, and making an account theirs. A dashboard admin never reports the detected time zone, or links an outside account to the guardian.

Each person's Concierge chats stay private to that person.

## Alternatives

- **Roles, with a permission per route.** Rejected because the guardian would have to learn a model to answer one question, whether a person may use this Rome, and every new route would need a role decision.
- **Keep approvals with the guardian.** Rejected because a dashboard admin then waits on the guardian for every action an agent asks to run, which is the work the guardian invited them to share.

## Consequences

A dashboard admin can approve or reject any approval, change the vault, and change what apps may reach through connections. The approval records which person resolved it.

Two routes still let a dashboard admin change the guardian's own person, and both stay open questions. `PUT /api/settings` accepts `guardianTimezone`, and `DELETE /api/devices/:deviceId` removes a device from the guardian's account and turns off its personal-data origin. A dashboard admin could do both before this decision, and nothing here checks them.

Future diffs must respect:

- A dashboard check asks whether the session actor is on the team. It never compares the actor's kind with `guardian` alone, except for the four exceptions.
- Removing an email from the dashboard allow-list takes the person off the team at their next request or connection. A live connection they have open stays until it closes.
- A visitor allow-listed for one app is not on the team.
