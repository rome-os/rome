# Slack bot

Rome uses its existing Slack connection for both workspace operations and bot conversations. One Rome instance connects one Slack workspace.

## Behavior

- A direct message to the Rome bot starts or continues a private conversation.
- An `@Rome` mention in a channel where the bot is invited starts or continues that channel thread. Rome posts its answer in the thread.
- Rome ignores ordinary channel messages, bot-authored messages, and messages without text.
- Rome ignores Slack Connect authors from external workspaces so their workspace-scoped user IDs cannot collide with local admission records.
- The first release sends and receives completed text messages only. If a direct message includes text with a file, Rome handles only the text. It does not handle files, images, or streamed partial answers.

During connection, Settings shows a one-time code. The guardian must direct-message that code to the bot before Rome stores the Slack grant or marks Talk ready. The code expires after five minutes, locks each sender after five incorrect code attempts, and is cancelled if setup is cancelled or replaced.

The guardian's linked Slack account is admitted automatically. Other workspace members must complete Rome's normal pairing approval before their message reaches the agent. Until then, Rome replies only with pairing guidance.

Rome does not request Slack's broad `users:read` scope. Pairing approvals therefore identify a requester by the workspace/member ID shown by Slack rather than a fetched profile name. Before approving an unfamiliar ID, open that member's Slack profile, choose **More**, and use **Copy member ID** to compare it with Rome's approval. Approval notifications return to the requesting direct message or mention thread. This release does not initiate unsolicited direct messages.

When bot events are enabled on an instance that already has a connector-only Slack grant, Rome marks that legacy grant degraded until the guardian reconnects it in Settings and completes the one-time proof. This fail-closed migration temporarily pauses connector custody rather than allowing an unproven workspace identity to unlock Talk.
On an instance without `SLACK_SIGNING_SECRET`, Slack remains available as a connector-only OAuth integration. Bot setup and Talk are not offered there.

Answers longer than Slack's message limit are sent as sequential text messages. A transport failure after an earlier part was accepted can leave a partial answer, because Slack does not provide an idempotency key for `chat.postMessage`.
Outbound text is posted with Slack markup disabled. API calls have a bounded timeout and one bounded rate-limit retry.

## Slack app configuration

Use [`infra/slack/rome-bot-manifest.yml`](../../infra/slack/rome-bot-manifest.yml) as the versioned baseline. Direct Events API delivery is a single-instance topology: the deployment's Rome Cloud OAuth broker and the instance must use the same dedicated Slack application. A Slack application has one Events request URL, so do not share this direct-delivery app between instances. A multi-instance service needs a Rome Cloud event relay and workspace-to-instance routing, which this direct mode does not provide.

Before installing the manifest:

1. Register the same Slack application's client credentials in this deployment's Rome Cloud OAuth broker, then set the OAuth redirect URL to that broker's Slack callback.
2. Set the Events API request URL to `https://<instance-origin>/api/slack/events`.
3. Copy the app's signing secret into `SLACK_SIGNING_SECRET` on the Rome instance.
4. Recreate or restart the Rome service after changing the environment.

The bot scopes are limited to `chat:write`, `im:history`, and `app_mentions:read`.
Subscribe to `message.im`, `app_mention`, and the scope-free `app_uninstalled` and `tokens_revoked` lifecycle events.
Do not add channel-message subscriptions. Rome must not receive unmentioned channel traffic.
The manifest also enables a writable App Home Messages tab so workspace members can find and direct-message the bot.

Slack signs every Events API request. Rome limits the streaming request body before buffering it, verifies the signature against those exact untouched bytes, and rejects timestamps older than five minutes. It routes the event only to a bot token for the same workspace.
Event IDs are deduplicated for the lifetime of the Rome process. A restart clears that in-memory history, so Slack retrying or replaying a still-fresh signed event after a restart can deliver it again. Persistent cross-restart deduplication remains follow-up work.
When Slack supplies the application id in OAuth and event payloads, Rome also rejects delivery from a different application so a mismatched broker app and signing secret fail visibly instead of crossing identities.

## Deployment check

After deploying:

1. Confirm Slack accepts the Events API request URL challenge.
2. Connect Slack in **Settings → Connections** and send the displayed code to the bot.
3. Confirm Settings shows the workspace and `@Rome` bot identity.
4. Send the bot a direct message and verify one reply appears in that direct conversation.
5. Invite the bot to a test channel, mention it, and verify the reply appears in a thread.
6. Post an unmentioned channel message and verify Rome stays silent.
