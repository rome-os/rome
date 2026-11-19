# Slack app test environment

Everything the official Slack app and its verifier need to run with no person present: a fake Slack, Rome Cloud and the webhook relay, and two Rome instances enrolled in that Rome Cloud. The rules it serves are in the project's rule set (R1, R3, R4, R6, R7, R11 in phase 1). How it differs from production is in [DIFFERENCES.md](DIFFERENCES.md).

## Start and stop

```bash
environments/slack-app/up.sh      # builds and starts everything, writes env.json
environments/slack-app/down.sh    # stops everything and removes its state
```

`up.sh` refuses to start when the rome checkout, the rome-cloud checkout, or this folder has uncommitted changes. It writes `environments/slack-app/.state/env.json` (gitignored), which names the commits, the agent model, and every address and control endpoint.

## Fake Slack

`fake-slack/server.mjs` stands in for `slack.com`. It has no dependencies and runs on Node 22 or later. Its tests run with `node --test environments/slack-app/fake-slack/server.test.mjs`.

It serves:

- the approve screen, `GET /oauth/v2/authorize`, with the usual `client_id`, `scope`, `user_scope`, `redirect_uri` and `state`. Pressing Allow redirects to `redirect_uri` with `code` and `state`. Pressing Cancel redirects with `error=access_denied`. Optional `team` and `user` query parameters pick the workspace and the member signing in, and so does `POST /_control/sign-in`.
- the Web API under `/api/{method}`: `oauth.v2.access`, `auth.test`, `auth.revoke`, `chat.postMessage`, `conversations.open`, `users.info`. Arguments come as a form, JSON or a query, and the token as `Authorization: Bearer` or `token`. Unknown methods answer `unknown_method`. Every call is recorded.
- events, posted to the configured events address and signed as Slack signs them: `X-Slack-Request-Timestamp` and `X-Slack-Signature: v0=` HMAC SHA256 of `v0:{timestamp}:{body}` with the signing secret. An event that gets no 2xx is retried with `X-Slack-Retry-Num` and `X-Slack-Retry-Reason`.

The workspaces and their members are in `config/workspaces.json`: workspace A `TA0000AAAA` (Acme) and workspace B `TB0000BBBB` (Bayside), each with a guardian, two other members and a `#general` group. The bot user in a workspace is always `UBOT` plus the team id without its `T`, and a member's direct message with the bot is always the same conversation id, listed by `GET /_control/state`. The app is installed in a workspace once a sign-in there finishes, and one workspace has one bot token, as in Slack.

### Control API

All under `/_control`, JSON in and out.

| Call | What it does |
|---|---|
| `GET /health` | Answers `{ ok: true }`. |
| `GET /state` | The app's ids, the events address, each workspace with its install, bot ids, members with their direct-message conversation ids, and groups. |
| `POST /sign-in {team, user}` | Picks who the approve screen signs in as. |
| `POST /dm {team, user, text}` | A member sends the bot a direct message. Sends a signed `message.im` event and returns `event_id`, the `event` (with `channel` and `ts`), and the first `delivery` (status, time taken). Refused with 409 if the app is not installed in that workspace. |
| `POST /mention {team, user, channel?, text}` | A member mentions the bot in a group (default `general`). Sends a signed `app_mention` event. |
| `POST /forged {team, user, text, kind?, mode?}` | Sends a direct message (or, with `kind: "mention"`, a mention) that Slack did not sign. `mode` is `bad_signature` (default), `stale_timestamp` (signed, but 10 minutes old) or `missing_signature`. Forged events are not retried. |
| `POST /event {team, event, signature?}` | Sends any event body, signed unless `signature` names a forgery. |
| `POST /url-verification` | Sends Slack's `url_verification` challenge and returns what the address answered. |
| `POST /uninstall {team}` | Removes the app from a workspace: sends `tokens_revoked` and `app_uninstalled`, then the workspace's tokens stop working. |
| `GET /posts?team&channel&thread_ts&since` | What was posted through `chat.postMessage`, oldest first, each with `seq`, `channel`, `ts`, `threadTs`, `text` and the token kind. |
| `GET /calls?team&method&since` | Every Web API call received, with secrets redacted. |
| `GET /events?since` and `GET /deliveries?event_id&since` | Every event sent, and every delivery attempt with its status. |
| `POST /config {events_url?, retry_delays_ms?}` | Changes the events address or the retry delays while running. |
| `POST /reset {installs?}` | Clears the records. Keeps installs and tokens unless `installs` is true. |

Every record carries a `seq` from one counter, and each list answers with the current `seq`, so a test reads "everything since" by passing the `seq` it saw before acting.
