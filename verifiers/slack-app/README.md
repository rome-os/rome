# Slack app verifier

Scores the official Slack app on rule set v1, phase 1: R1, R3, R4, R6, R7 and R11 pass or fail, and every other rule reports "not checked" with its phase. It does not build the product or the environment. What it expects of them is in [CONTRACT.md](CONTRACT.md).

```bash
verifiers/slack-app/run.sh <env.json> [out dir]
```

It refuses to run when this folder has uncommitted changes, so a report always names the code that made it. It writes `report.json` and `report.md` (default `out/<time>/`, gitignored) with the commits of rome, rome-cloud, the environment and the verifier, the model, and each rule's result, reason and evidence: event ids, reply counts, and the screens Connect passed. It exits 1 when a rule fails.

## How each rule is checked

Every seeded message asks the Concierge to repeat a code unique to the message and the run. Slack links a reply in a direct message to nothing, so the code is how a reply is matched to the message it answers. A reply that carries several codes counts once for each.

| Rule | Run |
|---|---|
| R1 | Signs in to Slack as workspace A's guardian and walks Connect on the first instance the way the dashboard and a browser would, pressing Allow and filling nothing. Fails on any field from Rome's setup or Rome's own screens (Slack's own approve screen is not counted), on more than one sign-in or Slack approval, on a connected account whose agent is not `core:concierge`, and when the first direct message does not get exactly one reply. The verifier never calls an agent link route. |
| R3 | Walks Connect for workspace A on the second instance. Passes when the setup ends `failed` with a reason saying the workspace is already connected, the second instance gains no connected account, and one more direct message to the first gets exactly one reply. |
| R4 | 20 direct messages from the guardian, one at a time, each after the previous one's reply. Each must be answered within `replySeconds`, before the next is sent, and get exactly one reply in the same direct message, no reply may match no message, and the bot may post nowhere else in the workspace. |
| R7 | 10 direct messages with a bad signature, then one good message to show the path was open. No forged one may get a reply or be recorded in the direct message's session (which must show the good message, or the read proves nothing and R7 is not checked), and nothing but the good message's one reply may follow them anywhere in the workspace; each forged event is sent up to 3 times until Rome Cloud answers it with a status below 500, and R7 is not checked if one never is; the report keeps every delivery status. Then R4's 20 messages from workspace A: the instance bound to workspace B may not record them, post anything in workspace B, observe an account of workspace A, or make any Slack call naming their codes, workspace A, its guardian or the direct message. |
| R6 | Stops the first instance, sends 20 direct messages, holds the stop for `stopSeconds`, starts it, and wants each message answered exactly once and no reply while stopped. |
| R11 | `git diff <romeCloudBase> -- webhook-relay` in rome-cloud is empty. Columns added under `packages/pantheon` schemas and migrations hold only the workspace to instance binding (team, instance, timestamps). `pnpm lint:imports` passes in rome. No file under `packages/core/src/connections` imports from `rome_apps`. |

Runs go R11, R1, R3, then the second instance's binding to workspace B, R4, R7, R6. A rule whose setup failed earlier reports "not checked" with the reason.

## Stand-in

`prove.mjs` shows the verifier can tell good from broken before the product exists. It runs the environment's own fake Slack (taken from the environment branch by git ref), a stand-in Rome Cloud and relay (`standin/cloud.mjs`), and two stand-in instances (`standin/instance.mjs`) that refuse a mutation from another origin as Rome does, started by `standin/up.mjs`. `BREAK` switches one rule off at a time:

| Break | What the stand-in does wrong |
|---|---|
| `R1-fields` | Setup asks for a bot token and a signing secret. |
| `continue` | Not a break: Connect shows a Continue screen of Rome's own, a form with no method and nothing to fill. R1 must still pass. |
| `R1-twice` | Connect sends the guardian through the Slack sign-in twice. |
| `R1-agent` | The connected account gets no agent. |
| `R3` | Rome Cloud lets a second instance take a bound workspace. |
| `R4` | The instance replies twice to each message. |
| `R4-pairs` | Each odd message is answered only when the next one comes. |
| `R4-elsewhere` | Each reply is also posted in another member's direct message. |
| `R6` | The instance throws away its mailbox when it starts. |
| `R7-signature` | Rome Cloud skips Slack's signature check. |
| `R7-route` | Rome Cloud delivers every event to every bound instance. |
| `R7-lookup` (with `R7-route`) | The wrong instance looks up workspace A's sender in Slack, then drops the event unrecorded. |
| `R7-quiet` (with `R7-signature`) | Forged events get through and are answered without their code. |
| `R7-transport` | Rome Cloud drops every forged event's connection unanswered. R7 must report "not checked", not pass. |
| `R7-gateway` | A gateway answers 502 to every forged event. R7 must report "not checked". |
| `R7-blind` (with `R7-route`) | The wrong instance answers workspace A's events in its own workspace with a reply naming nothing of A, and records nothing. |
| `R6-stop-error` | The stop control stops the instance, then reports a failure. R6 must still restart it and pass. |
| `R7-elsewhere` (with `R7-signature`) | Forged events get through, are not recorded, and are answered in another member's direct message. |
| `R11` | The relay gains a Slack file. |
| `R11-migration` | A migration adds a bot token column with `ALTER TABLE`. |
| `R11-namespace` | A Drizzle schema written with a namespace import (`pg.text(...)`) stores the bot token. |
| `R11-eof` | A `CREATE TABLE` with no semicolon, ending the file, stores the bot token. |
| `R11-sql` | A one-line `CREATE TABLE` stores the bot token. |
| `R11-store` | Rome Cloud stores the bot token. |

```bash
node verifiers/slack-app/prove.mjs [environment git ref]
```

It passes when every phase 1 rule passes on the good stand-in and each break gets its expected result (fail, unless the table says otherwise), and writes `out/proof/summary.md`.

## Limits

- The verifier trusts the fake Slack's records of what the bot posted. A reply posted some other way is not seen.
- R6's stop is `stopSeconds` long, which the environment may shorten from production's hour.
- A Concierge that answers 20 waiting messages in one reply carrying all 20 codes passes R6, since each message is answered once. The evidence shows the reply count.
