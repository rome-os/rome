# Slack app verifier

Scores Rome's Slack app on rule set v4 (`/mnt/project-files/features/slack-official-app/rules.md`): R1 to R11 and R14, each a promise the Slack connection keeps. Every check reads the connection's two edges: the fake Slack on one side, and on the other what Rome has on record in Chats and what Slack received. No rule asks the Concierge anything or judges what it says. It does not build the product or the environment; what it expects of them is in [CONTRACT.md](CONTRACT.md).

```bash
verifiers/slack-app/run.sh [--r6-stop <seconds>] [--only <ids>] [--min-free-gb <n>] <env.json> [out dir]
```

It refuses to run when this folder has uncommitted changes, so a report always names the code that made it. It writes `report.json` and `report.md` (default `out/<time>/`, gitignored) with the commits of rome, rome-cloud, the environment and the verifier, the model, and each rule's result, reason and evidence. It exits 1 when a scored rule fails.

## How each rule is checked

Every seeded message carries a tag unique to the message and the run. "On record" means Rome's record of the chat holds a message with that tag: the environment's `record` control when it gives one, else the chat's session. "Arrived" means the fake Slack recorded the post.

Two optional controls decide how much can be seen. The `port` control calls the connection's own port (send, read, thread, groups, any other method). The `record` control reads Chats' own record of a chat. Without the port, R9's send, read and refusal, R14's group work and R10's send naming no sender are not checked, and R1's send is Rome's reply.

| Group | Rule | Run |
|---|---|---|
| Access | R1 | The guardian connects through Connect with one sign-in and nothing pasted. The connection's account is a Slack account that names the workspace. One direct message is on record, and one message Rome sends arrives in it: a port send, or without a port, Rome's post after the message (what it says is not read). The Rome Cloud sign-in attempt no longer holds its outcome. |
| Access | R2 | R1's whole check from a workspace that is not the app's home one. First, with the app's distribution off, Slack refuses the sign-in and nothing connects. |
| Access | R3 | A second instance connecting workspace A is refused and told why. A direct message to the first is still on record there. |
| Access | R8 | Slack's removal events mark the connection broken within 1 minute. The same sign-in fixes it into the same connected account, and a direct message is on record again. Disconnecting in Rome makes Slack's auth.test refuse the token. |
| Access | R10 | Connect lists Rome's Slack app once and offers no old kind. A new slack_bot or old OAuth connect is refused. After the environment seeds a slack_bot and an old `slack` connection, and again after a restart: Rome lists neither, the older bot does not answer, and a direct message to Rome's app is on record. A port send that names no sender is neither refused nor answered with senders to choose from, and arrives from Rome's app with its bot token. Both seeded rows are still stored (the `old-rows` control). Rome's log from the stop to "Rome started" holds no error-level entry and one warning per seeded row; after it, until the step ends, no error-level entry names an old row (its ids, `slack_bot`, an old kind, or the `connections` component), and other errors are listed as notes with counts. Nothing is posted through either old app, and no call uses the old sign-in's user token. |
| Hear | R4 | 20 direct messages one at a time, each on record before the next. Then 10 more: 3, a second's pause, the instance stopped, 7 while it is down: all 10 are on record after the restart, which a connection that acknowledged before recording would fail. Then the fake redelivers one recorded event: still on record once. The order inside Rome Cloud is covered by the product's tests (#2534). |
| Hear | R5 | 10 mentions from the guardian, 5 at the top of `#general` and 5 in threads a member started: all on record. Where the record shows a thread, each is on record with its own. A send into each thread lands in it: a port send, or Rome's post after the mention. Slack's pace on history reads is off while R5 runs. The "mentioned" fact is covered by the product's tests. |
| Hear | R6 | The instance stops for `stopSeconds`, 20 direct messages are sent while it is down, and all 20 are on record after the restart. |
| Hear | R7 | 10 events with a bad signature (each sent up to 3 times until Rome Cloud answers below 500): none on record, nothing posted before a good message, which is on record. R4's 20 events from workspace A: the instance bound to B makes no Slack call about them, posts nothing, observes no account of A and has no record of A's direct message. |
| Speak and act | R9 | Through the port: a send arrives from the bot token; a read of that chat holds it; `search.messages`, `chat.delete`, `conversations.invite`, `users.list` and `reactions.add` are refused with no call at the fake. Every Web API call the fake saw this run is a send, a read or the connection's upkeep (list in `rules/port.mjs`), and none uses a user token. |
| Speak and act | R14 | Through the port: the groups listed are `#general` and `#news`, never `#quiet`; a read of `#news` holds a message said there; a thread read holds its reply; a send to `#news` arrives; a read of `#quiet` shows nothing of it and a send there lands nothing. A plain message in `#news` and one in `#quiet`, sent as events too, are not on record, while a mention is. Workspace B signed in again under the old scopes: a direct message and a mention are on record, and the port refuses a group listing and a group read, saying to approve the app again. Not checked when the app asks for no group history. |
| Structure | R11 | Reads the checkouts: the relay gains no Slack code, core's connections import nothing from apps, and Rome Cloud's tables hold only workspace to instance, delivery and sign-in attempt state. |
| Outside the score | smoke | A direct message gets exactly one reply in it. It fails nothing. |

R12 is no longer a rule (Ouou, 2026-11-21).

Order: R11, R1, R3, the second binding (workspace B to the second instance), smoke, R4, R7, R5, R9, R14, R6, R8, R2, R10. R9 audits every call made before it. R6 stops the first instance, R8 disconnects it, R2 then connects it to the third workspace, and R10 seeds the old connections on the second instance last.

`--only` takes rule ids or a group name (`access`, `hear`, `speak`, `structure`). R1, R3 and the second binding always run.

## Worker side (rule set v5)

Rule set v5 (`rules.md`, approved 2026-11-21) moves Rome Cloud's Slack side into the `slack-gateway` Worker and adds R15 (the token stays in Rome Cloud). Until Rome's side of the Worker's contract lands, `run.sh --worker <env.json>` (`worker.mjs`) scores the Worker's side with the verifier's own stand-in instance, `gateway/agent.mjs`, run as rome-a and rome-b through the environment's `as_instance` control, so the instance JWT never leaves the instance's network. Each result names the parts only Rome can show as "needs the Rome side"; R1, R2, R10 and R14 are not checked.

| Rule | Worker side, as checked |
|---|---|
| R3 | The second instance's bind of workspace A answers 409 with a reason. The first still holds A, and its direct message reaches its mailbox, not the second's. |
| R4 | 20 direct messages, one at a time: each answered 200 to Slack, each in the instance's mailbox signed with its deposit key and `x-rome-slack: 1`. |
| R5 | 10 mentions, 5 in threads a member started: all in the mailbox, each threaded one with its thread. |
| R6 | 20 direct messages while nothing drains the mailbox for `stopSeconds`: all there after. |
| R7 | 10 events with a bad signature: refused to Slack (401) and in no mailbox. R4's 20 events of A: none in the mailbox of the instance bound to B. |
| R8 | Removing the app in Slack lets the workspace go within 1 minute; binding again from the same instance holds it again; disconnecting revokes the token (Slack's auth.test refuses it) and another instance can then bind the workspace. |
| R9 | A send arrives from the bot token and a read holds it; `search.messages`, `chat.delete`, `conversations.invite`, `users.list`, `reactions.add` and `auth.test` answer 403 with no call at the fake; every call the fake saw is a send, a read or upkeep, none with a user token. |
| R15 | No token the fake issued (its `GET /_control/tokens`) appears in any answer or delivery either instance got, in the Worker's log, or on the instance (`find_secret`). 10 calls from the instance bound to B in workspace A: 0 reach Slack. |
| R11 | As v4, and the Worker's tables (gateway/) are judged too: the binding, its delivery and the workspace's token pass; message content and member data fail. |

`prove-worker.mjs` proves it against a stand-in Worker (`standin/gateway.mjs`, with stand-in Rome Cloud, relay and signer) and a worktree of the real rome-cloud for R11. `BREAK` switches one promise off: `W-R3-takeover`, `W-R4-drop`, `W-R5-thread`, `W-R6-expire`, `W-R7-signature`, `W-R7-route`, `W-R8-uninstall`, `W-R8-keep-token`, `W-R8-held`, `W-R9-any`, `W-R15-token`, `W-R15-deposit`, `W-R15-log`, `W-R15-cross`, `W-R11-message`, `W-R11-relay`; each must fail its rule, and the good Worker must pass all nine.

## Stand-in

`prove.mjs` shows the verifier can tell good from broken before the product exists. It runs the environment's own fake Slack (taken from the environment branch by git ref), a stand-in Rome Cloud and relay (`standin/cloud.mjs`), and two stand-in instances (`standin/instance.mjs`) started by `standin/up.mjs`. The stand-in instance records each message before it acknowledges its mailbox, answers apart from recording, serves the port and record controls (`/_port`, `/_record`), and ignores stored old Slack connections. `STANDIN_NO_PORT=1` gives neither control, as the environment on main. `BREAK` switches one rule off at a time:

| Break | What the stand-in does wrong | Expected |
|---|---|---|
| `R1-fields` | Setup asks for a bot token and a signing secret. | R1 fails |
| `continue` | Not a break: Connect shows a Continue screen of Rome's own with nothing to fill. | R1 passes |
| `R1-twice` | Connect sends the guardian through the Slack sign-in twice. | R1 fails |
| `R1-kept` | Rome Cloud keeps the sign-in's outcome after the redemption. | R1 fails |
| `R1-account` | The connection's account does not name the workspace. | R1 fails |
| `silent` | The Concierge never replies. | smoke fails; with no port, R1 fails |
| `R2-own-only` | Rome Cloud connects only the team's own workspaces. | R2 fails |
| `R3` | Rome Cloud lets a second instance take a bound workspace. | R3 fails |
| `R4-early-ack` | The instance acknowledges its mailbox before it records, and records slowly. | R4 fails |
| `DUP-answers-twice` | A redelivered event is recorded again. | R4 fails |
| `R5-unrecorded` | Mentions are answered but never recorded. | R5 fails |
| `R5-thread` | A mention in a thread is recorded under another thread. | R5 fails |
| `R5-top` | A send to a thread lands at the top of the group. | R5 fails |
| `R6`, `R6-drop5` | The mailbox, or 5 of its messages, is thrown away at start. | R6 fails |
| `R6-stop-error` | The stop control stops the instance, then reports a failure. | R6 passes |
| `R7-signature`, `R7-route`, `R7-quiet`, `R7-elsewhere`, `R7-blind`, `R7-lookup` | Forged events get through, or events reach the wrong instance. | R7 fails |
| `R7-transport`, `R7-gateway` | Forged events never reach Rome Cloud, or a gateway answers 502. | R7 not checked |
| `R8-never`, `R8-new-account`, `R8-keep-token` | Removal never marks broken, the repair gives a new account, or disconnect keeps the token. | R8 fails |
| `R9-other-method` | The port calls any Slack method it is asked for. | R9 fails |
| `R9-no-read` | A read through the port answers nothing. | R9 fails |
| `R9-extra-call` | The instance lists the workspace's members on connect. | R9 fails |
| `R10-two-entries`, `R10-bot-connects`, `R10-oauth-connects` | Connect offers an old kind, or one can be started. | R10 fails |
| `R10-old-works` | Stored old connections are listed and the older bot answers. | R10 fails |
| `R10-two-senders`, `R10-sender-choice` | A stored old row counts as a second sender: a send naming none is refused, or answered with senders to choose from. | R10 fails |
| `R10-old-sender` | A send naming no sender goes out with the older bot's token. | R10 fails |
| `R10-restart-loses` | The stored old rows are deleted at the restart. | R10 fails |
| `R10-start-error` | Rome logs an error while starting, naming no old row. | R10 fails |
| `R10-log-error` | Once started, Rome logs an error naming each stored old row. | R10 fails |
| `R10-no-warn` | Rome skips the stored old rows without a warning. | R10 fails |
| `port-pair` | Not a break: each port call logs the scripted agent's two errors, as the environment's port does. | R10 passes, listing them as notes |
| `own-pace` | Not a break: the port paces reads at one per 90 s and says when to try again. | R9 and R14 pass, having waited |
| `R14-pace-long` | A thread read is refused with a wait past the verifier's 150 s cap. | R14 fails |
| `dm-only` | Not a break: the app asks for no group scopes. | R14 not checked |
| `R14-lists-all`, `R14-quiet-read`, `R14-no-thread`, `R14-hears-all` | The port lists or reads `#quiet`, reads no thread, or a plain group message is recorded. | R14 fails |
| `R14-no-reapprove` | Under the old scopes the port passes Slack's error through, not a request to approve again. | R14 fails |
| `R11`, `R11-*` | The relay gains Slack code, core imports an app, or Rome Cloud stores a token, message content or member data. | R11 fails |

It passes when every scored rule passes on the good stand-in, `no-port` gets R9, R10 and R14 not checked with the rest passing, and each break gets its expected result. It writes `out/proof/summary.md`. `PROVE_CASES=good,R5-top` runs only the named cases.

## Limits

- Slack paces history reads at about one a minute per workspace, and the product says so when it refuses one. R9 and R14 space each port read a minute after the last `conversations.history` or `conversations.replies` the fake saw in that workspace, and a read refused with a stated wait of at most 150 s is waited out and tried once more; the evidence records the wait. A refusal with no stated wait, or a second refusal, fails.

- The verifier trusts the fake Slack's records of what was posted and called.
- R4 cannot see when Rome Cloud's mailbox is acknowledged. A stop during a burst catches a connection that acknowledges early only when the stop lands between the acknowledgement and the record.
- Without a record control, Rome's record is the chat's session, which carries no thread, so R5 reports its thread facts as covered by the product's tests.
- R10 reads Rome's log through the `logs` control, asking for lines since a minute before the seed (`--since <time>`). A control that ignores that shows only its last lines, so R10 stops the instance and reads before each start, reads again after the start's checks, and reports a start not checked when the lines it last saw have scrolled out, or when no "Rome started" line is among them.
- R10's stored rows need the environment's `old-rows` control; without it that part is not checked.
- R6's stop is `stopSeconds` long: `run.sh --r6-stop <seconds>` (or `VERIFIER_R6_STOP_SECONDS`) wins, then env.json, then 120 s.
