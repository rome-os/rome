# Chief of staff environment

A Rome container of its own, built from this checkout, connected to a test Discord server through the chief of staff agent's Discord bot. Webhooks play the team, run by a second bot, the driver. The verifier posts as the members through their webhooks, reads what the agent writes back, and checks the agent against the rules. Every run starts from nothing.

## What it tests

- The chief of staff agent reading and answering in Discord chats, through today's Discord bot connection.
- Attribution to the right person, including a member with two accounts and a member whose display name changes mid-run, since every webhook a member posts through is linked to that member's person.
- The agent hearing other bots: every test chat has `activation.botMessages` set to `all`, because Discord marks webhook messages as bot messages.
- The agent answering the team: `up` sets the Inbox page's reply-to setting to the guardian, inner circle and acquaintances, and `seed` links the members as acquaintances unless `team.json` names another bond level. Every answer to a member still passes the envoy check, as in production, which can hold it for the guardian's approval.
- Renewal: the agent's answers survive a renewed session and a Rome restart.

## Differences from production

- **The team members are webhook authors, not people.** Each member posts through a webhook, and every one of its webhooks is linked to its person. A real teammate is a human Discord account, so nothing a real account does differently from a webhook is tested here.
- **Each member has one account per chat.** A webhook belongs to one chat, so a member's account in `general` is a different Discord author from its account in `standup`. Rome sees one person with several accounts, where a real member has one account in every chat. member1's second account, `member1:2`, is one more webhook in each of member1's chats.
- **Members cannot react or be mentioned.** A webhook cannot add a reaction, and a mention of a webhook author does not reach anyone, so the rules that need a member's reaction or a real mention of a member are not tested here. A member can still mention the agent.
- **A private chat stands in for a direct message.** A webhook cannot send a direct message, so a chat readable only by the agent and the driver (`dm-<member>`), where only that member posts, stands in for the member's direct message with the agent. The real direct message path is checked by hand once in the live trial, not here. `up` sets each private chat to answer every message, as a direct message is answered without a mention.
- **Every model tier runs on one cheap model.** `up` sends the large, medium and small tiers all to `claude-haiku-5-5`, to keep the bill down, through the same setting the dashboard's model picker writes. Production runs each tier on its own model, on the guardian's own model account, so a rule that only a stronger model meets can fail here. Set `COS_MODEL` to run on another model. `cos-env version` prints the model and the login.
- **No telemetry, mail, relay or push, and no Rome Cloud.** The container runs with only the two instance secrets and the model login, so anything that needs those services is not tested.
- **Rome reaches nobody from outside.** The container publishes no port. Every command reaches Rome through `docker exec`, the way a test harness on the same host does, not the way a browser reaches a hosted Rome.

## Setup

The secrets live in a file on the devbox, `~/.config/rome/cos.env`, outside the repository, with mode 600 and one `KEY=value` line per variable below. `COS_SECRETS_FILE` points elsewhere. The file is never committed or printed. A variable already set in the shell wins over the file, so a run can override one value, such as `COS_MODEL`.

Without that file, the commands read the same variables from the 1Password item `Chief of staff test` in the vault `Rome Dev`, one field per variable, through a service account whose token sits at `~/.config/op/service-account-token`. That path needs a 1Password plan with service accounts. `COS_OP_VAULT`, `COS_OP_ITEM` and `COS_OP_TOKEN_FILE` point elsewhere.

```
COS_DISCORD_SERVER_ID=      # the test Discord server's id
COS_AGENT_BOT_TOKEN=        # the bot token the chief of staff agent connects with
COS_DRIVER_BOT_TOKEN=       # the driver bot's token: runs the members' webhooks, reads and clears the test chats
ANTHROPIC_API_KEY=          # the model login: this, or the line below, not both
CLAUDE_CODE_OAUTH_TOKEN=
COS_MODEL=                  # optional: the model every tier runs on, claude-haiku-5-5 when unset
```

`up` stops and names the first required value missing, and where it looked. That makes two bots in total.

Both bots join the test server. The agent's bot takes the permissions the Discord connect guide lists (View Channels, Send Messages, Read Message History), with Message Content Intent turned on in the Developer Portal. The driver takes View Channels, Read Message History, Manage Webhooks, Manage Messages and Manage Threads, also with Message Content Intent. The test server needs these text chats, each named in `team.env` and readable by both bots:

- `general`, `standup`: member1, member2 and member3.
- `leads`: member1 and member2.
- `dm-member1`, `dm-member2`, `dm-member3`: that one member. Each stands in for a direct message.

`cos-env seed` makes each member's webhooks in the chats it is in and keeps their ids and tokens in the state folder, `~/.rome-environments/chief-of-staff/`, never in the repository. `seed` reuses the webhooks an earlier seed made, since Discord rate-limits making them, and `down` deletes them.

The three members are fixed identifiers (`member1`, `member2`, `member3`); their display names and the persons they map to come from the `team.json` that `cos-env seed` reads, so the roster can change without touching `team.env`.

## Commands

Run them from the repository root inside `nix develop`.

| Command | Does |
| --- | --- |
| `environments/chief-of-staff/env.sh up` | Builds the Rome image from this checkout, connects the agent's bot, links the agent, and sets every test chat to hear bots |
| `environments/chief-of-staff/env.sh up --no-build` | The same, reusing the last Rome image |
| `environments/chief-of-staff/env.sh reset` | Wipes Rome's home, memory and chats, clears the test chats' messages on Discord, then starts again. Run `cos-env seed` after it |
| `environments/chief-of-staff/env.sh down` | Deletes the members' webhooks and removes the Rome container, its volumes and its image. The test chats' messages stay |
| `environments/chief-of-staff/env.sh seed <dir>` | The same as `cos-env seed <dir>` |

### cos-env

The one command the verifier drives, and the only one it may call. Its contract stays stable across changes to the environment.

| Command | Does |
| --- | --- |
| `cos-env seed <dir>` | Makes each member's webhooks, links all of a member's webhooks (member1's second account's included) to the person `<dir>/team.json` names, sets the names the members post under, and hands the agent `<dir>/roster.md` and `<dir>/goals.md` through the agent app's own documents |
| `cos-env post --as <member> --chat <name> [--thread <id>] [--mention-agent] <text>` | Posts as the member through its webhook in that chat, and prints the message id. `--as` takes `member1`, `member2`, `member3`, or `member1:2`. `--mention-agent` prefixes a mention of the agent. `--thread <message id>` posts in the thread off that message, starting it from the message when needed (pass `--chat` so it can start it) |
| `cos-env dm --as <member> <text>` | Posts in that member's private chat (`dm-<member>`), which stands in for a direct message to the agent. Prints the message id |
| `cos-env read --chat <name> [--thread <id>] [--since <message id>]` | Prints the chat's messages as JSON, oldest first. Without `--thread`, includes the chat's threads' messages too, each tagged with its thread id or null. `--since` returns only messages after that id, which may come from any chat |
| `cos-env read --dm <member> [--since <message id>]` | Prints that member's private chat (`dm-<member>`) the same way |
| `cos-env rename --as <member> <display name>` | Sets the name the member's later messages carry. Messages already sent keep theirs, as on Discord |
| `cos-env rome stop\|start\|restart` | Stops, starts or restarts the Rome container |
| `cos-env rome renew-session --chat <name>` | Arms a session renewal on the chat: sets its reset policy so a reset is due, then restarts Rome. The next message to the agent in that chat opens the session cold and renewed. `cos-env reset` restores the chat's reset policy |
| `cos-env reset` | The same as `env.sh reset` |
| `cos-env version` | Prints as JSON the commit and dirty flag of the Rome under test (`rome`), of `rome_apps/chief-of-staff` (`agent`), of the verifier (`verifier`) and of the environment (`environment`), plus the model login and the instance's tier-to-model mapping. The verifier stamps every report with it |

Rome's log for each container, kept whole across restarts, is copied to `~/.rome-environments/chief-of-staff/run/logs/` whenever `up`, `reset` or `down` replaces the container. `docker logs rome-env-chief-of-staff-rome` shows the current one.

A message's `author`, as `read` prints it, is `member1`, `member2`, `member3` (every webhook of a member, both accounts', reads as the member), `agent`, `driver`, or the Discord username for anyone else. `authorId` carries the raw Discord author id, which tells member1's two accounts apart.
