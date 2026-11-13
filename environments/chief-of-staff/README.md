# Chief of staff environment

A Rome container of its own, built from this checkout, connected to a test Discord server through the chief of staff agent's Discord bot. Three more bots play the team. The verifier posts as those bots, reads what the agent writes back, and checks the agent against the rules. Every run starts from nothing.

## What it tests

- The chief of staff agent reading and answering in Discord chats, through today's Discord bot connection.
- Attribution to the right person, including a member whose display name changes mid-run, since each member bot's account is linked to a person.
- The agent hearing other bots: every test chat has `activation.botMessages` set to `all`, because the members are bots.

## Differences from production

- **The team members are bots, not people.** Each of Ava, Ben and Cleo is a Discord bot whose account is linked to a person of that name. A real teammate is a human Discord account, so nothing a real account does differently from a bot is tested here.
- **A member bot cannot send the agent a direct message.** Discord refuses a direct message from one bot to another, so `cos-env dm` fails against a bot agent. A direct message from a person to the agent is not tested here. (Rome's own direct-message handling is covered by the dashboard and by unit tests.)
- **The member bots share the test server with the agent bot.** All four join one server. Production has one Rome bot per server, among human members.
- **The model is whichever login the secrets file carries.** `cos-env version` prints which login and the instance's tier-to-model mapping. Production runs on the guardian's own model account.
- **No telemetry, mail, relay or push, and no Rome Cloud.** The container runs with only the two instance secrets and the model login, so anything that needs those services is not tested.
- **Rome reaches nobody from outside.** The container publishes no port. Every command reaches Rome through `docker exec`, the way a test harness on the same host does, not the way a browser reaches a hosted Rome.

## Setup

`up` needs a secrets file at `~/.rome-environments/chief-of-staff/secrets.env`, outside the repository. It is never committed or printed. It sets:

```
COS_DISCORD_SERVER_ID=      # the test Discord server's id
COS_AGENT_BOT_TOKEN=        # the bot token the chief of staff agent connects with
COS_MEMBER_1_BOT_TOKEN=     # Ava's bot token (also reads and clears the test chats)
COS_MEMBER_2_BOT_TOKEN=     # Ben's bot token
COS_MEMBER_3_BOT_TOKEN=     # Cleo's bot token
ANTHROPIC_API_KEY=          # the model login: this, or the line below, not both
CLAUDE_CODE_OAUTH_TOKEN=
```

`up` stops and names the first value missing. The four bots all join the test server, with the permissions the Discord connect guide lists (View Channels, Send Messages, Read Message History). Ava's bot reads and clears the chats, so it also needs Manage Messages and Manage Threads. The test server needs the text chats named in `team.env` (`general` and `planning`). The team roster, the chat names and the agent name are in `team.env`, which is not secret.

## Commands

Run them from the repository root inside `nix develop`.

| Command | Does |
| --- | --- |
| `environments/chief-of-staff/env.sh up` | Builds the Rome image from this checkout, connects the agent's bot, links the agent, sets the test chats to hear bots, and links each member's account to a person |
| `environments/chief-of-staff/env.sh up --no-build` | The same, reusing the last Rome image |
| `environments/chief-of-staff/env.sh reset` | Wipes Rome's home, memory and chats, clears the test chats' messages on Discord, then starts again |
| `environments/chief-of-staff/env.sh down` | Removes the Rome container, its volumes and its image. The secrets file and the test chats' messages stay |

### cos-env

The one command the verifier drives, and the only one it may call. Its contract stays stable across changes to the environment.

| Command | Does |
| --- | --- |
| `cos-env post --as <member> --chat <name> [--thread <id>] [--mention-agent] <text>` | Posts as the member's bot, and prints the message id. `--mention-agent` prefixes a mention of the agent bot |
| `cos-env dm --as <member> <text>` | Sends the agent a direct message as the member's bot, and prints the message id (see the difference above: it fails against a bot agent) |
| `cos-env read --chat <name> [--thread <id>] [--since <message id>]` | Prints the chat's or thread's messages as JSON, oldest first: `id`, `author`, `authorId`, `text`, `thread`, `time`, `replyTo`, `reactions`. `author` reads `agent` for the agent bot, the member's name for a member, the Discord username otherwise. `--since` returns only messages after that id |
| `cos-env rename --as <member> <display name>` | Sets the member bot's display name in the test server |
| `cos-env rome stop\|start\|restart` | Stops, starts or restarts the Rome container |
| `cos-env reset` | The same as `env.sh reset` |
| `cos-env version` | Prints as JSON the commit and dirty flag of the Rome under test, of `rome_apps/chief-of-staff`, of the verifier, and of the environment, plus the model login and the instance's tier-to-model mapping. The verifier stamps every report with it |
