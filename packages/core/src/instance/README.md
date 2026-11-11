# Instance

Which Rome this is and whether it is healthy: its identity and its link to Rome Cloud, upgrades, resource readings, time zone, and the diagnostics report sent with feedback.

## Imports

- Instance may import no other context, as [`lint/rules/contexts.ts`](../../../../lint/rules/contexts.ts) checks.
- It is imported by App host, Access, Agents, Apps, Concierge, Connections, Desktops, Favors, People and Relay.
- Instance imports no other context. The other contexts read the instance's identity and health, never the other way round.
- One crossing is listed until ZHA-169: the diagnostics report reads whether the relay is set up.
