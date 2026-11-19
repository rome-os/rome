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
      "connect": { "kind": "slack", "grant": "default" },   // assumed
      "messagesPath": "/..."           // assumed: see "Recorded messages"
    }
  ]
}
```

## Fake Slack control

The environment's control API, as its README gives it (`environments/slack-app/README.md`). The verifier uses `GET /state` (workspaces, and the guardian as the member with `is_owner`), `POST /sign-in`, `POST /dm`, `POST /forged` with `mode: bad_signature`, `GET /posts?team&channel&since` and `GET /calls?team&since`. It reads only records after the `seq` it saw before acting.

## Instance

The routes the dashboard uses today, relative to `api`:

| Route | Used for |
|---|---|
| `POST /connections/{kind}/grants/{grant}/setup {another: true}` | Starts Connect. Answers `{cid, state}`. |
| `GET /setups/{cid}` | Polls the setup's state: `awaiting-input` (a form, which R1 counts and does not fill), `awaiting-redirect` (a URL the verifier walks as a browser), `presenting`, `done`, `failed`. |
| `POST /setups/return {state, handoff?, error?, message?}` | Hands back the query of the URL the sign-in returned the browser to, the way the dashboard's callback page does. The verifier stops the browser at the first URL on the instance's origin that carries `state`. |
| `GET /connected-accounts` | Each connected account with its `agent` and `connection`. R1 wants `agent` to be `core:concierge`. |

R3 expects a refused second connect to end the setup `failed` with a `reason` the guardian can read.

### Recorded messages

*Assumed*, and the one route the product must add or name: `GET {messagesPath}` answers `{messages: [{text, ...}]}` with every message Rome recorded from Slack. R7 needs it to prove a forged or misrouted event was not recorded. Without it, R7 reports "not checked" when it sees no failure.

## Stop and start

`control.stop` and `control.start` are each a URL the verifier POSTs to, or a shell command. The verifier takes an instance as stopped once its API stops answering, and as started once it answers again.
