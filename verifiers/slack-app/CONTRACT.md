# What the verifier expects of the environment and the product

The verifier reads one `env.json` and talks to three things: the fake Slack, each instance's API, and each instance's stop and start controls. This file is the shape it codes against. Fields marked *assumed* are guesses until the environment or the product publishes theirs, and are the first places to adjust.

## env.json

```jsonc
{
  "commits": { "rome": "<sha>", "romeCloud": "<sha>", "environment": "<sha>" },
  "model": "claude-haiku-5-5",
  "differences": { },                  // copied into the report as is
  "stopSeconds": 120,                  // R6's stop; production's is 3600
  "r12": { "allowMembers": false },    // R12 turns replies to members on first
  "timeouts": { "replySeconds": 90, "settleSeconds": 10, "restartSeconds": 300 },
  "repos": {                           // checkouts R11 reads
    "rome": "/abs/path/rome",
    "romeCloud": "/abs/path/rome-cloud",
    "romeCloudBase": "origin/main"
  },
  "slack": { "control": "http://host:port/_control" },
  "romeCloud": { "query": ["argv", "..."] },  // R1: SQL on stdin, a JSON array of rows out
  "instances": [                       // first binds to workspace A, second to B
    {
      "name": "a",
      "api": "http://host:port/api",
      "headers": { "cookie": "..." },  // assumed: how the verifier signs in as the guardian
      "control": {
        "stop": "<URL to POST, or a shell command>", "start": "...",
        "wipeChat": ["argv", "..."],   // R13: the Slack conversation id is appended
        "tokenFile": ["argv", "..."],  // R9: prints {exists, bot_token_tail, user_token_tail, team_id}
        "oldConnections": ["argv", "..."] // R10: seeds slack_bot and slack; prints {slack_bot, slack, checks}
      },
      "connect": { "kind": "slack_app", "grant": "bot" }
    }
  ]
}
```

The verifier also reads the environment's own env.json (`version: 1`, written by `environments/slack-app/tools/write-env-json.mjs`) and maps it to this shape: `commits.rome_cloud`, `agent.model`, `fake_slack.control`, each instance's `url` (plus `/api`), `guardian_cookies_file` (sent as the cookie header), `stop` and `start` argv arrays, and `shortened.r6_stop_minutes`, plus `instances[i].control.wipe_chat` (or `instances[i].wipe_chat`), `instances[i].control.token_file`, `instances[i].control.old_connections` and `rome_cloud.query`, all argv arrays. R9 runs the existing tests in `repos.rome` and reports not checked unless `rome_dependencies` is `installed`. R11 reads `repos` (`rome`, `rome_cloud`, `rome_cloud_base_ref`, `rome_base_ref` (default `origin/main`), and `rome_dependencies`: when it is `failed`, the import-rule check reports not checked). Without `repos`, R11 takes the checkouts from `VERIFIER_ROME_DIR`, `VERIFIER_ROME_CLOUD_DIR` and `VERIFIER_ROME_CLOUD_BASE` (default `origin/main`), and reports "not checked" without them.

## Fake Slack control

The environment's control API, as its README gives it (`environments/slack-app/README.md`). The verifier uses `GET /state` (workspaces, and the guardian as the member with `is_owner`), `POST /sign-in`, `POST /dm`, `POST /forged` with `mode: bad_signature`, `GET /posts?team&channel&since` and `GET /calls?team&since`. Phase 2 adds `POST /mention` (R5), `POST /group-message {team, user, channel?, text}` (R5), `POST /uninstall {team}` (R8) and `POST /auth-test {team}`, answering `{token_state, auth_test}` with Slack's auth.test answer for the newest bot token issued in the workspace (R8). R13 counts `conversations.history` and `conversations.replies` in `/calls` after the wipe. Phase 3 adds, for R2, `distribution {on, home_team}` in `GET /state`, a third workspace that is not the home one and that no instance signs in to, `POST /config {distributed}` (answering `distributed`), and `GET /approvals?since`, each answer on the approve screen as `{teamId, userId, outcome: approved|cancelled|refused, error}`. For R10: `POST /socket-event {app_id, event}` and `appId` on each post. For R9: `bot_token_tail` per workspace in `GET /state`, groups `#general`, `#news` (the app is in it) and `#quiet` (it is not) in workspace A, `POST /group-message` into either, `POST /dm {send_event: false}` (history only), `POST /config {history_limit}`, and `tokenKind` on each record of `GET /calls` and `GET /posts`. It reads only records after the `seq` it saw before acting.

## Instance

The routes the dashboard uses today, relative to `api`. Every call sends the instance's own `Origin` and `Sec-Fetch-Site: same-origin`, since Rome refuses a mutation from another origin.

| Route | Used for |
|---|---|
| `POST /connections/{kind}/grants/{grant}/setup {}` | Starts Connect. Answers `{cid, state, reattached}`. An instance holds one Slack workspace in phase 1, so the body takes no `another` (Rome answers 400 to it). When `reattached` is true a setup was already live, and the verifier posts again with `{force: true}` to start its own. |
| `GET /setups/{cid}` | Polls the setup's state: `awaiting-input` (a form, which R1 counts and does not fill), `awaiting-redirect` (a URL the verifier walks as a browser), `presenting`, `done`, `failed`. |
| `POST /setups/return {state, handoff?, error?, message?}` | Hands back the query of the URL the sign-in returned the browser to, the way the dashboard's callback page does. The verifier stops the browser at the first URL on the instance's origin that carries `state`. |
| `GET /connected-accounts` | Each connected account with its `agent` and `connection`. R1 wants `agent` to be `core:concierge`. |
| `GET /connections/{connection id}` | The connection's view. The verifier reads `connection.channel`, the channel the connection backs, to name the chat Rome recorded. The connection id is the one the setup's done state gave. |
| `GET /sessions/channel:{channel}:{direct message id}/messages` | The bot chat's session for one Slack direct message, as an array oldest first of `{id, role, content, ...}`. `{channel}` comes from the connection's view, never from the direct message id alone. The verifier keeps inbound entries, role `notification` or `user` (an inbound message that started a turn), and searches their `content`. The People timeline is not used: it leaves agent chats out. Rome has no public listing that gives a connection's chats with their session ids, so the name is built from the view. |
| `GET /connections/{connection id}` (R8, R13) | R8 polls its `state` for `broken` after the removal. R13 compares the whole view, less `setups`, before and after the wipe. A 404 is read as the connection being gone. |
| `GET /settings`, `PUT /settings {replyToBondLevels}` | R12 with allowMembers: reads the setting, sets `["guardian", "other"]` so members who are not the guardian get replies, and puts the old value back after. |
| `DELETE /connections/{connection id}` | R8's disconnect, as the dashboard's Disconnect does. |
| `GET /connections` (R10) | The Connect picker: its entries with `id` null are the placeholders, and a Slack one has a `connectionKind` or `label` naming Slack. |
| `POST /connections/slack_bot/grants/bot/setup`, `GET /oauth/slack/start` (R10) | The old kinds' connect routes. Refused means a non-2xx answer or a `failed` setup; a redirect counts as refused only when it carries an error. |
| `GET /action-executions?limit=200` (R9) | Root executions with their children. An execution after an ask whose action name or input names Slack, #news or #quiet counts as the Concierge attempting that operation. Optional: without it, only calls at the fake count. |
| `GET /accounts` | Every account the instance has observed, as `{accounts: [{channel, channelUserId}], nextCursor}`. The verifier reads every page and keeps channel `slack` (or `slack_app`), since the filter matches the platform name exactly. A dropped event adds none. |

R3 expects a refused second connect to end the setup `failed` with a reason that says the workspace is already connected, in any words. The product refuses on redeem, after the browser returns with a handoff.

R7 reads what Rome recorded through the session route above: a forged event must leave nothing in the direct message's session, which must show the good message, and the instance bound to workspace B must hold no account of workspace A and no session for A's direct message (a 404 there means none). If a read fails, including a 403 or 404 on the first instance, R7 reports "not checked" unless it already saw a failure.

## Wipe and query

Before asking anything after the wipe, R13 searches the instance through the dashboard's own routes, `GET /memory/search?q=` and `GET /chat/sessions/search?q=`, for each fact's telling words. Any hit leaves R13 not checked, since a right answer could come from what the instance kept. If neither route answers, R13 relies on the wipe's `remaining` and says so.

`control.wipe_chat` wipes Rome's copy of one Slack conversation. The verifier runs it with the conversation id appended, then a `--text <text>` pair for each of R13's fact values and their telling words of 8 characters or more, so the wipe also removes what Rome distilled from the chat, memory included (or POSTs to it with `?conversation=&text=` when it is a URL) and takes exit 0 as the copy being gone and the instance healthy again. Exit 3 means a copy is left, and R13 is not checked. It prints JSON with what it removed, which goes into R13's evidence. The verifier never reads Rome's database itself.

`rome_cloud.query` takes SQL on stdin and prints rows as a JSON array, read only. R1 runs `select result is null as cleared, consumed_at is not null as consumed from slack_app_installs order by created_at desc limit 1`.

## Stop and start

`control.stop` and `control.start` are each a URL the verifier POSTs to, or a shell command. The verifier takes an instance as stopped once its API stops answering, and as started once it answers again.
