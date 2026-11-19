# Slack app verifier

Scores the official Slack app on rule set v2, phases 1 and 2: R1, R3, R4, R6, R7 and R11 (phase 1) and R5, R8, R12 and R13 (phase 2) pass or fail, and every other rule reports "not checked" with its phase. It does not build the product or the environment. What it expects of them is in [CONTRACT.md](CONTRACT.md).

```bash
verifiers/slack-app/run.sh [--r6-stop <seconds>] [--r12-allow-members] <env.json> [out dir]
```

It refuses to run when this folder has uncommitted changes, so a report always names the code that made it. It writes `report.json` and `report.md` (default `out/<time>/`, gitignored) with the commits of rome, rome-cloud, the environment and the verifier, the model, and each rule's result, reason and evidence: event ids, reply counts, and the screens Connect passed. It exits 1 when a rule fails.

## How each rule is checked

Every seeded message asks the Concierge something harmless and carries a tag unique to the message and the run. A reply is matched to its message by where and when the fake Slack records it, not by what it says: a post in the message's direct message after it and before the next message is its reply, since messages go one at a time, each after the previous one's reply. A post in any other conversation is listed apart and fails the rule. The tag is only for finding Rome's records and Slack calls about a message; no reply needs to repeat it. Reasons say how many replies were posted in the direct message and how many messages got exactly one. Only R12 and R13 read what a reply says, and only for seeded values. Each fact is an ordinary thing made distinctive by unusual words (a boat called Spindrift Marlowe), never by digits or anything that looks like a code, and a reply holds it when one of its telling words appears.

| Rule | Run |
|---|---|
| R1 | Signs in to Slack as workspace A's guardian and walks Connect on the first instance the way the dashboard and a browser would, pressing Allow and filling nothing. Fails on any field from Rome's setup or Rome's own screens (Slack's own approve screen is not counted), on more than one sign-in or Slack approval, on a connected account whose agent is not `core:concierge`, and when the first direct message does not get exactly one reply. The evidence keeps "connected" and "replied" apart, and R3's keeps "second refused" and "first replied" apart, so a silent agent is not read as a failed connect. The verifier never calls an agent link route. With `rome_cloud.query` in env.json, R1 also reads Rome Cloud's newest sign-in attempt after the connect, and fails if its outcome (`result`) is still held after the redemption. No row left counts as cleared. |
| R3 | Walks Connect for workspace A on the second instance. Passes when the setup ends `failed` with a reason saying the workspace is already connected, the second instance gains no connected account, and one more direct message to the first gets exactly one reply. |
| R4 | 20 direct messages from the guardian, one at a time, each after the previous one's reply. Each must be answered within `replySeconds`, before the next is sent, and get exactly one reply in the same direct message, no reply may match no message, and the bot may post nowhere else in the workspace. |
| R7 | 10 direct messages with a bad signature, then one good message to show the path was open. No forged one may get a reply or be recorded in the direct message's session (which must show the good message, or the read proves nothing and R7 is not checked), and nothing but the good message's one reply may follow them anywhere in the workspace; each forged event is sent up to 3 times until Rome Cloud answers it with a status below 500, and R7 is not checked if one never is; the report keeps every delivery status. Then R4's 20 messages from workspace A: the instance bound to workspace B may not record them, post anything in workspace B, observe an account of workspace A, or make any Slack call naming their codes, workspace A, its guardian or the direct message. |
| R5 | 10 mentions of the app in workspace A's `general` group, one at a time. Each must get exactly one reply in a thread under it (`thread_ts` is the mention's `ts`). Nothing may be posted at the top of the group, in another thread or outside the group. Then a group message that does not mention the app (`POST /_control/group-message`) must get no post anywhere; if that route is missing, R5 is not checked. Slack sends the app no event for it, since the app subscribes to no group messages, so this catches only a product that reads the group's history and answers. |
| R12 | The guardian tells the Concierge 5 private facts that are not credentials (a salary, a home address, a medical appointment, a sister's name, a planned surprise), then asks one back, which must come back or R12 is not checked. A member who is not the guardian then sends 10 ordinary questions about the guardian, two per fact. Each must get exactly one reply in that member's direct message, and no reply to them may hold any fact's telling words. With `--r12-allow-members` (or `VERIFIER_R12_ALLOW_MEMBERS=1`, or env.json `r12.allowMembers`), R12 first sends the member one question and keeps what came back as evidence, then turns replies to members on as a guardian would (`PUT /settings {replyToBondLevels: ["guardian", "other"]}`), scores, and puts the setting back. Without it, R12 scores the instance's default. |
| R13 | The guardian states 10 facts in two messages of five, then asks them back in two messages of five questions, with Rome's copy. With the replies that is 8 messages, so the facts sit within the last 15 messages of the direct message, the most Slack gives an app like this one in one request. Then `control.wipe_chat` wipes Rome's copy of that direct message (exit 3 or `ok: false` leaves R13 not checked), and the 10 questions are asked one at a time. The first may take up to 150 s, since one history request may wait out Slack's minute; the rest keep `replySeconds`. All 10 must come back right, one reply each, the same as before the wipe. The connection's view (less its live setups) and the connection's connected accounts must read the same before and after. The reason states how many history requests Slack saw after the wipe (counted at the fake Slack, refused ones too) and how long the first answer took. Without `wipe_chat`, R13 is not checked. |
| R6 | Stops the first instance, sends 20 direct messages, holds the stop for `stopSeconds`, starts it, and wants exactly 20 replies in that direct message after the restart, none while stopped and none anywhere else. |
| R8 | Runs last. Removes the app from workspace A (`POST /_control/uninstall`) and polls the connection's view until its `state` is `broken`, which must come within 60 s. Walks Connect again with the same sign-in: the new connection must have the same connected account (`account`) with agent `core:concierge`, no field may be asked, and a direct message must get exactly one reply. Then disconnects in Rome (`DELETE /connections/{id}`): `POST /_control/auth-test` must answer ok before and `token_revoked` (or any refusal) after. If auth.test cannot be run, R8 is not checked. |
| R11 | `git diff <romeCloudBase> -- webhook-relay` in rome-cloud is empty. Each column added under `packages/pantheon` schemas and migrations is judged by what it holds. Message content and Slack member data fail in any table. The binding (team, instance, timestamps) and the means of delivery (mailbox id, forward secret) pass. A sign-in attempt table (one with an expiry and attempt state such as `state` or `code_challenge`) is judged by its lifetime, not its column names: all its other columns pass as attempt fields when the product's code clears the sign-in outcome (a column such as `result` or a token) on redemption, by setting it to null or deleting the row, and deletes expired attempts. Otherwise they fail. Outside an attempt table a Slack token fails, and a column it cannot judge leaves R11 not checked. `pnpm lint:imports` passes in rome. No import from `rome_apps` is added under `packages/core/src/connections` against `romeBase` (default `origin/main`); every current one is listed. |

Runs go R11, R1, R3, then the second instance's binding to workspace B, R4, R7, R5, R12, R13, R6, R8. A rule whose setup failed earlier reports "not checked" with the reason.

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
| `R7-quiet` (with `R7-signature`) | Forged events get through and are answered "Sure, done." |
| `refuse` | Not a break: the Concierge declines what it was asked, in one reply to each message. Every phase 1 rule must still pass. |
| `R1-kept` | Rome Cloud keeps the sign-in's outcome after the instance redeemed it. |
| `R5-top` | Mentions are answered at the top of the group, not in a thread. |
| `R5-twice` | Each mention gets two replies in its thread. |
| `R12-leak` | The visitor is told the guardian's private facts. |
| `R12-default-mode` | Not a stand-in fault: R12 scores the guardian-only default, so the visitor gets no reply and R12 fails. |
| `R12-ignore-setting` | Turning replies to members on changes nothing. |
| `R13-forget` | With Rome's copy wiped, the instance never reads Slack, so the answers are lost. |
| `R13-tell` | The connection's view shows that it had to read Slack. |
| `R8-never` | Removing the app never marks the connection broken. |
| `R8-new-account` | The repair gives a new connected account. |
| `R8-keep-token` | Disconnecting in Rome leaves the token working. |
| `silent` | The Concierge never replies. |
| `R7-transport` | Rome Cloud drops every forged event's connection unanswered. R7 must report "not checked", not pass. |
| `R7-name` | The chat is recorded under a name the connection's view does not lead to. R7 must report "not checked" with the read error. |
| `R7-gateway` | A gateway answers 502 to every forged event. R7 must report "not checked". |
| `R7-blind` (with `R7-route`) | The wrong instance answers workspace A's events in its own workspace with a reply naming nothing of A, and records nothing. |
| `R6-drop5` | 5 of the 20 messages waiting at restart are lost. |
| `R6-stop-error` | The stop control stops the instance, then reports a failure. R6 must still restart it and pass. |
| `R7-elsewhere` (with `R7-signature`) | Forged events get through, are not recorded, and are answered in another member's direct message. |
| `R11` | The relay gains a Slack file. |
| `R11-migration` | A migration adds a bot token column with `ALTER TABLE`. |
| `R11-namespace` | A Drizzle schema written with a namespace import (`pg.text(...)`) stores the bot token. |
| `R11-eof` | A `CREATE TABLE` with no semicolon, ending the file, stores the bot token. |
| `R11-sql` | A one-line `CREATE TABLE` stores the bot token. |
| `R11-store` | Rome Cloud stores the bot token in the binding. |
| `R11-message` | Rome Cloud stores message content. |
| `R11-member` | Rome Cloud stores a Slack member's email. |
| `R11-token-kept` | The sign-in attempt's outcome (it carries the bot token) is never cleared on redemption. |
| `R11-no-sweep` | Nothing deletes expired sign-in attempts. |
| `R11-import` | The product adds an import from an app in core's connections. |

```bash
node verifiers/slack-app/prove.mjs [environment git ref]
```

It passes when every phase 1 and phase 2 rule passes on the good stand-in and each break gets its expected result (fail, unless the table says otherwise), and writes `out/proof/summary.md`. `PROVE_CASES=good,R5-top` runs only the named cases.

The stand-in keeps the fake Slack's history limit on (15 messages a request, one request a minute). The stand-in instance stops reading once it has the fact, and waits out a 429. It gives env.json a `wipe_chat` URL and a `rome_cloud.query` command (`standin/query.mjs`).

## Limits

- The verifier trusts the fake Slack's records of what the bot posted. A reply posted some other way is not seen.
- R6's stop is `stopSeconds` long: `run.sh --r6-stop <seconds>` (or `VERIFIER_R6_STOP_SECONDS`) wins, then env.json, then 120 s. The rule's stop is 3600 s, so a full-length run is `run.sh --r6-stop 3600 <env.json>`.
- R6 cannot tell which of the 20 waiting messages a reply answers, since they share a direct message: it wants exactly 20 replies in all. A Concierge that answers one message twice and another not at all passes R6; R4 catches that case one message at a time.
