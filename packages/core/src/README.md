# `@rome/core` source contexts

This folder is split into contexts, one folder each. A context owns one part of the model, and the import rules in [`lint/rules/contexts.ts`](../../../lint/rules/contexts.ts) fix which other contexts each one may import. Every pair the rules do not allow is a lint error, type-only imports included. The words each context uses are defined in [`../domains/`](../../../docs/domains/README.md).

## Contexts

| Folder | Context | What it owns | May import |
|---|---|---|---|
| `access/` | Access | Who may open what: the `Principal` asking (the guardian, a signed-in visitor, or someone not signed in) and the `Permission` on each thing. Also guardian and visitor sign-in, and the dashboard allow-list. | Instance |
| `agent/` | Agents | What an agent is and how it runs: its definition, the model account and model it runs on, and the agent session that takes its turns with Rome's tools. It defines the extension points apps plug into. | Instance |
| `app-host/` | App host | Builds each app's `ctx` from every other context, runs the app worker, and loads the agents and skills apps ship. | every context except Desktops and Participation |
| `apps/` | Apps | What an app is and its whole life: catalog, install, upgrade, uninstall, artifacts, the store, remix and publish, and the actions and hooks an app runs. | Access, Instance |
| `chats/` | Chats | Who said what, where, and as whom: chats, their messages and history, the accounts in them, and the connected accounts messages arrive on. | Access, Agents, Apps, Connections, Participation, People |
| `concierge/` | Concierge | Each owner's Concierge: its main chat and topic chats, the task chats it hands work to, its follows and tasks, and the digests, alerts and pushes it sends. | Access, Agents, Apps, Chats, Connections, Instance, Routines, Webchat |
| `connections/` | Connections | What access Rome has to which external account: a connection, its one grant, the setup flow that makes it, and the adapters that carry messages in and out. Also what an app may do through a connection. | Apps, Chats, Desktops, Instance, Participation, People |
| `desktops/` | Desktops | The machines Rome can reach and what it can do on them: the named desktops, computer use, and Rome nodes. | Access, Instance |
| `favors/` | Favors | Favor requests, a visitor's request that Rome runs an app action for them, and how each is fulfilled through Rome Cloud. | Access, Apps, Instance |
| `instance/` | Instance | Which Rome this is and whether it is healthy: its identity and its link to Rome Cloud, upgrades, resource readings, time zone, and the diagnostics report sent with feedback. | no other context |
| `participation/` | Participation | When an agent takes part in a chat. The code holds only the per-chat queue of inbound messages and the rule that keeps a message that was only a mention. | no other context |
| `people/` | People | Who is behind an account and how close they are to the guardian: people, their profiles, the links from accounts to people, and each person's timeline. | Apps, Chats, Connections, Instance |
| `relay/` | Relay | The Rome Cloud relay: it drains the webhooks Rome Cloud holds for this instance and hands each to an app's public API. | Apps, Instance |
| `routines/` | Routines | Scheduled work: a routine, the schedule, event or manual trigger that fires it, and the agent turn or app action it runs. | Access, Agents, Apps |
| `webchat/` | Webchat | The dashboard chat, Rome's own chat and not a connection: its chats and projects, who owns each and who may open it, uploads, and continuing a turn after a restart or a usage limit. | Access, Agents, Apps, Chats, Participation |

## Rules beyond the table

- Apps is foundational. Contexts that use apps build on it, and App host fills in what an app receives from the other contexts, so Apps imports only Access and Instance.
- No context imports App host. `index.ts` and the worker's entry point start it.
- Concierge, Favors and Relay are imported only by App host. Routines and Webchat are imported only by App host and Concierge.
- Agents never imports Apps or Connections. Apps supplies the extension points Agents defines, and an agent never knows which connection carries its chat.
- Connections never imports Webchat, since the dashboard chat is not a connection.
- Favors never imports Agents, Chats, Connections or People. No agent takes part in a favor request, and it names no chat, account or connection. Its visitor is known by their Rome Cloud account, not as a person.
- Desktops never names a chat, account, person, app or connection. A connection that needs a screen asks Desktops for one.
- Instance imports no other context. One crossing is listed until ZHA-169: the diagnostics report reads whether the relay is set up.

## Folders outside the contexts

The import rules do not check the other folders under `packages/core/src`, such as `api/`, `db/`, `lib/` and `wiring/`. `sessions/` is one of them: it holds the records of each agent session for chats on every platform (`rome_sessions`), and where each session speaks. Chats, Connections, Agents and Webchat read and write those records through it.
