# Chief of staff environment

A Rome container of its own, built from this checkout, connected to a test Discord server through the chief of staff agent's Discord bot. More bots play the team. The verifier posts as those bots, reads what the agent writes back, and checks the agent against the rules. Every run starts from nothing.

## What it tests

- The chief of staff agent reading and answering in Discord chats, through today's Discord bot connection.
- Attribution to the right person, including a member with two accounts and a member whose display name changes mid-run, since each member bot's account is linked to a person.
- The agent hearing other bots: every test chat has `activation.botMessages` set to `all`, because the members are bots.
- Renewal: the agent's answers survive a renewed session and a Rome restart.

## Differences from production

- **The team members are bots, not people.** Each member is a Discord bot whose account is linked to a person. A real teammate is a human Discord account, so nothing a real account does differently from a bot is tested here.
- **A private chat stands in for a direct message.** Discord refuses a direct message between two bots, so a chat readable only by the agent and one member (`dm-<member>`) stands in for that member's direct message with the agent. The real direct message path is checked by hand once in the live trial, not here.
- **The member bots share the test server with the agent bot.** All the bots join one server. Production has one Rome bot per server, among human members.
- **The model is whichever login the secrets file carries.** `cos-env version` prints which login and the instance's tier-to-model mapping. Production runs on the guardian's own model account.
- **No telemetry, mail, relay or push, and no Rome Cloud.** The container runs with only the two instance secrets and the model login, so anything that needs those services is not tested.
- **Rome reaches nobody from outside.** The container publishes no port. Every command reaches Rome through `docker exec`, the way a test harness on the same host does, not the way a browser reaches a hosted Rome.

## Setup

`up` needs a secrets file at `~/.rome-environments/chief-of-staff/secrets.env`, outside the repository. It is never committed or printed. It sets:

```
COS_DISCORD_SERVER_ID=      # the test Discord server's id
COS_AGENT_BOT_TOKEN=        # the bot token the chief of staff agent connects with
COS_MEMBER_1_BOT_TOKEN=     # member1's bot token (also reads and clears the test chats)
COS_MEMBER_2_BOT_TOKEN=     # member2's bot token
COS_MEMBER_3_BOT_TOKEN=     # member3's bot token
COS_MEMBER_4_BOT_TOKEN=     # optional: member1's second account, for `--as member1:2`
ANTHROPIC_API_KEY=          # the model login: this, or the line below, not both
CLAUDE_CODE_OAUTH_TOKEN=
```

`up` stops and names the first required value missing. That makes five bots in total, and the run works with the first four. The fourth member token is optional: only `cos-env post --as member1:2` needs it, so without it K3's two-account check reports as not checked.

The bots all join the test server with the permissions the Discord connect guide lists (View Channels, Send Messages, Read Message History), with Message Content Intent turned on in the Developer Portal. Each member bot also needs Change Nickname, for `cos-env rename`. member1's bot reads and clears the chats, so it also needs Manage Messages and Manage Threads. The test server needs these text chats, each named in `team.env`:

- `general`, `standup` — every member and the agent.
- `leads` — member1, member2 and the agent only.
- `dm-member1`, `dm-member2`, `dm-member3` — the agent and that one member only. Each stands in for a direct message.

The three members are fixed identifiers (`member1`, `member2`, `member3`); their display names and the persons they map to come from the `team.json` that `cos-env seed` reads, so the roster can change without touching `team.env`.

## Commands

Run them from the repository root inside `nix develop`.

| Command | Does |
| --- | --- |
| `environments/chief-of-staff/env.sh up` | Builds the Rome image from this checkout, connects the agent's bot, links the agent, and sets every test chat to hear bots |
| `environments/chief-of-staff/env.sh up --no-build` | The same, reusing the last Rome image |
| `environments/chief-of-staff/env.sh reset` | Wipes Rome's home, memory and chats, clears the test chats' messages on Discord, then starts again |
| `environments/chief-of-staff/env.sh down` | Removes the Rome container, its volumes and its image. The secrets file and the test chats' messages stay |
| `environments/chief-of-staff/env.sh seed <dir>` | The same as `cos-env seed <dir>` |

### cos-env

The one command the verifier drives, and the only one it may call. Its contract stays stable across changes to the environment.

| Command | Does |
| --- | --- |
| `cos-env seed <dir>` | Links member1–member3 to the persons `<dir>/team.json` names, sets their server display names, and hands the agent `<dir>/roster.md` and `<dir>/goals.md` through the agent app's own documents. With the fourth bot token, links member1's second account to member1's person |
| `cos-env post --as <member> --chat <name> [--thread <id>] [--mention-agent] <text>` | Posts as the member's bot, and prints the message id. `--as` takes `member1`, `member2`, `member3`, or `member1:2`. `--mention-agent` prefixes a mention of the agent. `--thread <message id>` posts in the thread off that message, starting it from the message when needed (pass `--chat` so it can start it) |
| `cos-env dm --as <member> <text>` | Posts in that member's private chat (`dm-<member>`), which stands in for a direct message to the agent. Prints the message id |
| `cos-env read --chat <name> [--thread <id>] [--since <message id>]` | Prints the chat's messages as JSON, oldest first. Without `--thread`, includes the chat's threads' messages too, each tagged with its thread id or null. `--since` returns only messages after that id, which may come from any chat |
| `cos-env read --dm <member> [--since <message id>]` | Prints that member's private chat (`dm-<member>`) the same way |
| `cos-env rename --as <member> <display name>` | Sets the member bot's display name in the test server |
| `cos-env rome stop\|start\|restart` | Stops, starts or restarts the Rome container |
| `cos-env rome renew-session --chat <name>` | Arms a session renewal on the chat: sets its reset policy so a reset is due, then restarts Rome. The next message to the agent in that chat opens the session cold and renewed. `cos-env reset` restores the chat's reset policy |
| `cos-env reset` | The same as `env.sh reset` |
| `cos-env version` | Prints as JSON the commit and dirty flag of the Rome under test (`rome`), of `rome_apps/chief-of-staff` (`agent`), of the verifier (`verifier`) and of the environment (`environment`), plus the model login and the instance's tier-to-model mapping. The verifier stamps every report with it |

A message's `author`, as `read` prints it, is `member1`, `member2`, `member3` (both of a member's accounts read as the member), `agent`, or the Discord username for anyone else.
