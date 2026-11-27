# Access: Guardian, Visitor, Dashboard Admin, Team

Who has a role in this Rome is in the [Access](../domains/access.md) domain language. This page holds the engineering contracts behind the guardian, and the words of its own: visitor, dashboard admin and team.

## Guardian

The guardian is the single human user that a Rome instance serves. They control all configuration, memory, and policies. The guardian's profile (name, timezone, preferences) is stored in [memory](data.md#memory).

**Contracts:**

- One Rome instance serves exactly one guardian. There is no multi-guardian mode.
- The guardian is always the highest-trust [bond level](people.md#bond-levels). No person can outrank them.
- Only the guardian can approve or reject an [approval-gated action](messaging.md#approvals).
- The guardian's full access is inherent. Every other authenticated caller is a [visitor](#visitor) whose access is granted and revocable.

**Not to be confused with:**

- **[Person](people.md#person)** — a person is someone the guardian knows. The guardian is the one the instance serves.
- **[Visitor](#visitor)** — a visitor holds scoped access the guardian granted. The guardian owns the instance and can never be outranked by one.
- **The agent's identity** — the agent has its own name and personality, stored separately from the guardian's profile.

## Visitor

A visitor is the holder of a [Rome Cloud](rome-cloud.md) account that the guardian has granted scoped access to. A visitor authenticates by signing in to that account — the sign-in flow and its edge enforcement live in [access control](../architecture/access-control.md).

**Contracts:**

- A visitor reaches only the surfaces its email is allow-listed for: individual access-gated apps, or the full dashboard as a [dashboard admin](#dashboard-admin). A visitor never holds the guardian's credential.
- A dashboard admin sees an instance upgrade when one is offered and can start it, exactly as the guardian can, on the web and in the phone app. The upgrade restarts the instance for everyone on it.
- The visitor's email is authoritative from the Rome Cloud sign-in exchange. Nothing the browser supplies can set or change it.
- Every request re-checks allow-list membership, so removing an email refuses their next request or connection at once rather than at the next sign-in. A live connection they have open [stays until it closes](../architecture/access-control.md#entry). The email comparison is case-insensitive.
- Each sign-in keeps the visitor's email and Rome Cloud picture in `visitor_profiles`, replacing the last one. Chat reads it to show who sent a message, so it is display only and never authenticates anyone.

**Not to be confused with:**

- **[Guardian](#guardian)** — the guardian owns the instance and holds full access. A visitor holds scoped access the guardian granted.
- **[Person](people.md#person)** — a person is someone the guardian knows, carrying a bond level. A visitor is an authenticated caller, and the two are orthogonal — a visitor need not be a tracked person.

## Dashboard admin

A dashboard admin is a [visitor](#visitor) whose email is on the dashboard allow-list. The guardian adds them in Settings > Team, and they use the dashboard as the guardian does, as part of the [team](#team).

**Contracts:**

- A dashboard admin passes every dashboard check the guardian passes, approvals, the vault and app-connection access included, apart from the four [exceptions](#team).
- A dashboard admin has their own Concierge while it is on. Memory and connections stay shared.
- Removing the email ends dashboard admin access at the next request.

**Not to be confused with:**

- **[Guardian](#guardian)** — the guardian owns the instance. A dashboard admin's access is granted and revocable.
- **An app visitor** — a visitor allow-listed for one app reaches only that app, never the dashboard.

## Team

The team is the guardian and every [dashboard admin](#dashboard-admin). Access answers whether a session actor is on the team, reading the dashboard allow-list at the moment it is asked ([decision](../adrs/a-dashboard-admin-has-the-guardians-access.md)).

**Contracts:**

- Every dashboard check admits the team, except four that stay the guardian's: billing for the instance, deleting the instance, removing or replacing the guardian's seat or its credentials, and what is the guardian's own person.
- What is the guardian's own person covers their personal data, their device connections and their detected time zone. A dashboard admin reads the guardian's personal data and device connections. A dashboard admin pushes no personal data, pauses or deletes no personal-data origin, registers no device connection, and reports no detected time zone.
- A Concierge chat opens to the guardian and every dashboard admin, whoever owns it. The chat list shows a person their own.

**Not to be confused with:**

- **A role** — the team has one level of access. Rome has no roles or per-route permissions.
- **An app visitor** — a visitor allow-listed for one app is not on the team.
