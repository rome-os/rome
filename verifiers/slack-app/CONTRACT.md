# What the verifier expects of the environment and the product

The verifier reads one `env.json` and talks to the fake Slack, each instance's API, and each instance's controls. This file is the shape it codes against.

## env.json

```jsonc
{
  "commits": { "rome": "<sha>", "romeCloud": "<sha>", "environment": "<sha>" },
  "model": "claude-haiku-5-5",
  "differences": { },                  // copied into the report as is
  "stopSeconds": 120,                  // R6's stop
  "timeouts": { "replySeconds": 90, "settleSeconds": 10, "restartSeconds": 300, "reachSeconds": 90 },
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
      "headers": { "cookie": "..." },  // how the verifier signs in as the guardian
      "control": {
        "stop": "<URL to POST, or argv, or a shell command>", "start": "...",
        "oldConnections": ["argv"],    // R10: seeds slack_bot and slack; prints {slack_bot, slack, checks}
        "oldRows": ["argv"],           // R10: read only; prints {slack_bot: {connection_id, stored}, slack: {...}}
        "port": ["argv"],              // optional: the connection's port, below
        "record": ["argv"],            // optional: Chats' record of one chat, below
        "logs": ["argv"]               // optional: recent log lines, for the memory warning
      },
      "connect": { "kind": "slack_app", "grant": "bot" }
    }
  ]
}
```

The verifier also reads the environment's own env.json (`version: 1`, written by `environments/slack-app/tools/write-env-json.mjs`) and maps it to this shape: `commits.rome_cloud`, `agent.model`, `fake_slack.control`, each instance's `url` (plus `/api`), `guardian_cookies_file` (sent as the cookie header), `stop` and `start` argv arrays, `shortened.r6_stop_minutes`, `instances[i].control.old_connections`, `.old_rows`, `.port`, `.record` and `.logs`, `repos`, and `rome_cloud.query`. When an instance names no `port`, `record`, `old_rows` or `logs`, the verifier uses ctl.sh's own (`ctl.sh port <instance>`, `ctl.sh record <instance>`, `ctl.sh old-rows <instance>`, `ctl.sh logs <instance>`), found beside its stop command. R11 reads `repos` (`rome`, `rome_cloud`, `rome_cloud_base_ref`, `rome_base_ref`, `rome_dependencies`); without them it takes `VERIFIER_ROME_DIR`, `VERIFIER_ROME_CLOUD_DIR` and `VERIFIER_ROME_CLOUD_BASE`, and reports "not checked" without those either.

## Port and record controls

Both are argv arrays the verifier runs with arguments appended, reading the JSON printed on stdout (the whole output, else its last JSON line). A URL instead is POSTed `{args: [...]}`.

`port <op> '<json>'` calls the connection's own port, built only on surfaces the product already has:

| op | Arguments | Answer |
|---|---|---|
| `send` | `{chat, text, thread?}` | The send's result. |
| `read` | `{chat}` | The chat's recent messages, in any shape that holds their text. |
| `thread` | `{chat, ts}` | The thread's messages. |
| `groups` | `{}` | The groups the app is in, holding their ids. |
| `call` | `{method, args}` | Any other Slack method, which must be refused. |

A refusal is `{refused: why}`, or an error object carrying `at` (`rome` or `connector`) with its words in `error`, `reason` or `message`. R14 reads the words of a refusal for a request to approve the app again.

`record '{"chat": "<id>"}'` reads Chats' own record of one chat, read only, with the instance running or stopped. The chat is a D... or C... id, or `C...:<thread ts>` for a thread. It prints `{messages: [{key, text, at, thread?}]}`. If it fails once, the verifier reads the session route below for the rest of the run.

## Old rows and logs (R10)

`old-rows` reads, without changing anything, whether the rows the `old-connections` seed wrote are still stored, with the instance running or stopped. It prints `{slack_bot: {connection_id, stored}, slack: {connection_id, stored}}` (or `{rows: [{connection_id, kind}]}` listing the stored ones). If it fails or is missing, that part of R10 is not checked.

`logs [--since <ISO time>]` prints the instance's log (since that time when given), one entry a line, as `compose logs` does: JSON after the service's prefix, with `level` (a name or pino's number). R10 counts error-level entries, and warnings that name a seeded row's connection id (else its account id, else its kind).

## Fake Slack control

The environment's control API (`environments/slack-app/README.md`). The verifier uses `GET /state` (workspaces with members, groups, scopes, `history_limit`, `distribution`), `POST /sign-in`, `POST /dm`, `POST /forged {mode: bad_signature}`, `POST /mention {thread_ts?}`, `POST /group-message {channel, thread_ts?, send_event?}`, `POST /redeliver {event_id}` (R4; a 404 "no control route" leaves that part not checked), `GET /deliveries?event_id`, `GET /posts?team&channel&since` (with `threadTs`, `appId`, `tokenKind`), `GET /calls?team&method&since` (with `method`, `teamId`, `tokenKind`), `POST /uninstall`, `POST /auth-test`, `POST /config {history_limit, distributed}`, `GET /approvals?since`, `POST /grant-limit {team, scopes}` and `POST /socket-event`. It reads only records after the `seq` it saw before acting.

## Instance

Routes relative to `api`. Every call sends the instance's own `Origin` and `Sec-Fetch-Site: same-origin`.

| Route | Used for |
|---|---|
| `POST /connections/{kind}/grants/{grant}/setup {}`, `GET /setups/{cid}`, `POST /setups/return` | Connect, walked as the dashboard and a browser do. A form in `awaiting-input` counts as a field asked for. |
| `GET /connections` | Each held connection with its `account` (`{platform, id}`), and Connect's placeholders (`id` null) for R10. |
| `GET /connections/{id}` | The connection's view: `channel` names its chat sessions, `state` shows `broken` (R8). A 404 reads as gone. |
| `DELETE /connections/{id}` | R2 and R8's disconnect. |
| `GET /sessions/channel:{channel}:{chat}/messages` | Rome's record of a chat when there is no record control: inbound entries (role `notification` or `user`), oldest first. |
| `GET /accounts` | R7: every account the instance observed; none of workspace A may be on the instance bound to B. |
| `POST /connections/slack_bot/grants/bot/setup`, `GET /oauth/slack/start` | R10: the old kinds' connect routes, which must refuse. |

R3 expects a refused second connect to end the setup `failed` with a reason that says the workspace is already connected, in any words.

`rome_cloud.query` takes SQL on stdin and prints rows as a JSON array, read only. R1 runs `select result is null as cleared, consumed_at is not null as consumed from slack_app_installs order by created_at desc limit 1`.

## Stop and start

`control.stop` and `control.start` are each a URL the verifier POSTs to, an argv array, or a shell command. The verifier takes an instance as stopped once its API stops answering, and as started once it answers again.
