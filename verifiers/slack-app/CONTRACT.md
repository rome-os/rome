# What the verifier expects of the environment and the product

The verifier reads one `env.json` and talks to three things: the fake Slack, each instance's API, and each instance's stop and start controls. This file is the shape it codes against. Fields marked *assumed* are guesses until the environment or the product publishes theirs, and are the first places to adjust.

## env.json

```jsonc
{
  "commits": { "rome": "<sha>", "romeCloud": "<sha>", "environment": "<sha>" },
  "model": "claude-haiku-5-5",
  "differences": { },                  // copied into the report as is
  "stopSeconds": 120,                  // R6's stop; production's is 3600
  "timeouts": { "replySeconds": 90, "settleSeconds": 10, "restartSeconds": 300 },
  "repos": {                           // checkouts R11 reads
    "rome": "/abs/path/rome",
    "romeCloud": "/abs/path/rome-cloud",
    "romeCloudBase": "origin/main"
  },
  "slack": { "control": "http://host:port/_control" },
  "instances": [                       // first binds to workspace A, second to B
    {
      "name": "a",
      "api": "http://host:port/api",
      "headers": { "cookie": "..." },  // assumed: how the verifier signs in as the guardian
      "control": { "stop": "<URL to POST, or a shell command>", "start": "..." },
      "connect": { "kind": "slack_app", "grant": "bot" }
    }
  ]
}
```

The verifier also reads the environment's own env.json (`version: 1`, written by `environments/slack-app/tools/write-env-json.mjs`) and maps it to this shape: `commits.rome_cloud`, `agent.model`, `fake_slack.control`, each instance's `url` (plus `/api`), `guardian_cookies_file` (sent as the cookie header), `stop` and `start` argv arrays, and `shortened.r6_stop_minutes`. R11 reads `repos` (`rome`, `rome_cloud`, `rome_cloud_base_ref`, and `rome_dependencies`: when it is `failed`, the import-rule check reports not checked). Without `repos`, R11 takes the checkouts from `VERIFIER_ROME_DIR`, `VERIFIER_ROME_CLOUD_DIR` and `VERIFIER_ROME_CLOUD_BASE` (default `origin/main`), and reports "not checked" without them.

## Fake Slack control

The environment's control API, as its README gives it (`environments/slack-app/README.md`). The verifier uses `GET /state` (workspaces, and the guardian as the member with `is_owner`), `POST /sign-in`, `POST /dm`, `POST /forged` with `mode: bad_signature`, `GET /posts?team&channel&since` and `GET /calls?team&since`. It reads only records after the `seq` it saw before acting.

## Instance

The routes the dashboard uses today, relative to `api`. Every call sends the instance's own `Origin` and `Sec-Fetch-Site: same-origin`, since Rome refuses a mutation from another origin.

| Route | Used for |
|---|---|
| `POST /connections/{kind}/grants/{grant}/setup {another: true}` | Starts Connect. Answers `{cid, state}`. |
| `GET /setups/{cid}` | Polls the setup's state: `awaiting-input` (a form, which R1 counts and does not fill), `awaiting-redirect` (a URL the verifier walks as a browser), `presenting`, `done`, `failed`. |
| `POST /setups/return {state, handoff?, error?, message?}` | Hands back the query of the URL the sign-in returned the browser to, the way the dashboard's callback page does. The verifier stops the browser at the first URL on the instance's origin that carries `state`. |
| `GET /connected-accounts` | Each connected account with its `agent` and `connection`. R1 wants `agent` to be `core:concierge`. |
| `GET /sessions/channel:slack_app:{direct message id}/messages` | The bot chat's session for one Slack direct message, as an array oldest first of `{id, role, content, ...}`. The verifier keeps entries with role `notification` (inbound) and searches their `content`. The People timeline is not used: it leaves agent chats out. |
| `GET /accounts` | Every account the instance has observed, as `{accounts: [{channel, channelUserId}], nextCursor}`. The verifier reads every page and keeps channel `slack` (or `slack_app`), since the filter matches the platform name exactly. A dropped event adds none. |

R3 expects a refused second connect to end the setup `failed` with a reason that says the workspace is already connected, in any words. The product refuses on redeem, after the browser returns with a handoff.

R7 reads what Rome recorded through the session route above: a forged event must leave nothing in the direct message's session, which must show the good message, and the instance bound to workspace B must hold no account of workspace A and no session for A's direct message (a 404 there means none). If a read fails, including a 403 or 404 on the first instance, R7 reports "not checked" unless it already saw a failure.

## Stop and start

`control.stop` and `control.start` are each a URL the verifier POSTs to, or a shell command. The verifier takes an instance as stopped once its API stops answering, and as started once it answers again.
