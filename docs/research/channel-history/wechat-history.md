# Does the WeChat bot platform offer a history read?

No. The iLink bot platform Rome's WeChat adapter talks to (`ilinkai.weixin.qq.com`) exposes exactly one inbound-message endpoint, `getupdates`, and that endpoint only drains a forward-only cursor of messages the platform has not yet delivered to the bot. It has no endpoint that reads a message by id, lists conversations, or replays anything already delivered. This holds against Rome's own adapter code, against Tencent's own published reference client (`@tencent-weixin/openclaw-weixin`, exact version `2.4.3`, the version Rome's adapter pins itself against), and against three independent third-party technical write-ups of the same protocol. Tencent's own terms for this feature state Tencent does not store the message content server-side at all. So none of the four reads Rome wants from a channel — `count`, `latest`, a full read, and `readConversation` — can be answered by asking the platform. Every one of them needs a mirror Rome fills for itself as `getupdates` delivers messages.

## What the adapter does today

### Endpoints

Rome's `WechatAdapter` (`packages/core/src/channels/wechat.ts`) calls seven `ilinkai.weixin.qq.com` paths, all under the `ilink/bot/` prefix:

- `ilink/bot/get_bot_qrcode?bot_type=3` (GET) — mint a QR login attempt (`packages/core/src/channels/wechat.ts:408-416`).
- `ilink/bot/get_qrcode_status?qrcode=<qrcode>` (GET) — poll the scan status until confirmed (`packages/core/src/channels/wechat.ts:418-440`).
- `ilink/bot/getupdates` (POST) — long-poll for new messages, 35-second server hold (`packages/core/src/channels/wechat.ts:442-465`, `LONG_POLL_TIMEOUT_MS` at `packages/core/src/channels/wechat.ts:30`).
- `ilink/bot/getconfig` (POST) — fetch a `typing_ticket` for a target user (`packages/core/src/channels/wechat.ts:467-490`).
- `ilink/bot/sendtyping` (POST) — send the typing indicator (`packages/core/src/channels/wechat.ts:492-510`).
- `ilink/bot/sendmessage` (POST) — send a text or media message (`packages/core/src/channels/wechat.ts:516-541` for text, `packages/core/src/channels/wechat.ts:710-736` for media).
- `ilink/bot/getuploadurl` (POST) — get a CDN pre-signed upload URL for an attachment (`packages/core/src/channels/wechat.ts:552-582`).

None of the seven reads anything other than what the bot has not yet seen. `getupdates` is the adapter's only inbound-message read, and it is a drain of new messages since a cursor, not a lookup.

### Request and response shapes

The inbound message shape the adapter parses is `WechatMessage` (`packages/core/src/channels/wechat.ts:182-194`): `from_user_id`, `to_user_id`, `client_id`, `session_id`, `group_id`, `message_type`, `message_state`, `item_list`, `context_token`, `create_time_ms`. The `getupdates` response shape is `GetUpdatesResp` (`packages/core/src/channels/wechat.ts:196-203`): `ret`, `errcode`, `errmsg`, `msgs`, `get_updates_buf`, `longpolling_timeout_ms`. The adapter sends only `get_updates_buf` and `base_info` on each poll (`packages/core/src/channels/wechat.ts:451-453`) — there is no field for a starting point, a date range, or a message id, so there is no way to ask the endpoint for anything but what comes next.

### Identifiers

The adapter treats `from_user_id` as the person id (`senderId` at `packages/core/src/channels/wechat.ts:932`, exposed as `channelUserId`) and reuses it as the thread id for a direct conversation (`threadId = senderId` at `packages/core/src/channels/wechat.ts:935`). `group_id`, when present, becomes `threadName` and marks the thread a group (`packages/core/src/channels/wechat.ts:933-934, 948-949`). A comment at `packages/core/src/channels/wechat.ts:954-956` notes WeChat group traffic is partitioned by sender id, so a command can only ever address that sender's own Rome conversation, never another group member's.

### No history, backfill, or list-conversations call

Every one of the seven endpoints above sends a command (log in, poll, send, get a ticket, get an upload URL) or receives the next slice of a forward cursor. None accepts a message id, a date range, or a conversation id to look up. The only path that returns message content is `getupdates`, and its only input is the opaque `get_updates_buf` cursor from the last call.

### `MAX_CONTEXT_TOKENS`

`MAX_CONTEXT_TOKENS = 1_000` (`packages/core/src/channels/wechat.ts:34`) bounds an in-memory map from thread/user id to the platform's routing `context_token` (`packages/core/src/channels/wechat.ts:1117, 1447-1481`), persisted to `context_tokens.json` (`packages/core/src/channels/wechat.ts:1443-1445, 1476-1481`). This is not a message-history buffer. A `context_token` is a short-lived value the platform hands back on every inbound message and requires unmodified on the matching reply (`packages/core/src/channels/wechat.ts:1332-1339`), and the map exists only so `sendMessage` can find the right one for a given target (`packages/core/src/channels/wechat.ts:1354-1372`). `MAX_CONTEXT_TOKENS` caps the map at 1,000 entries and evicts the oldest on overflow (`packages/core/src/channels/wechat.ts:1467-1474`), the same as loading it caps the persisted set on read (`packages/core/src/channels/wechat.ts:1447-1457`).

### No context or history sent to the platform

`sendTextMessage` and `sendMediaMessage` send the current outgoing item plus its routing `context_token`, and nothing else (`packages/core/src/channels/wechat.ts:526-537, 710-732`). Neither passes prior messages, a conversation transcript, or anything resembling history back to the platform.

### Comments referencing the reference client

Two comments in the adapter name Tencent's reference client directly:

- `packages/core/src/channels/wechat.ts:36`: "Match Tencent's reference client: give a stale session one quiet hour before retrying."
- `packages/core/src/channels/wechat.ts:1252`: "...while Tencent's one-hour cooldown is active."

Both back `STALE_SESSION_ERRCODE = -14` and `SESSION_PAUSE_DURATION_MS = 60 * 60 * 1_000` (`packages/core/src/channels/wechat.ts:35, 37`), and both match the reference client's own constants exactly (see below).

### Cursor persistence is a resume point, not a history index

The adapter persists the latest `get_updates_buf` to a state file (`syncBufPath`, `packages/core/src/channels/wechat.ts:1439-1441`) and loads it on `poll()` start (`packages/core/src/channels/wechat.ts:1267`), so a restart resumes from where it left off rather than replaying from the start. Only the single latest cursor value is ever kept — there is no stored list of earlier cursors and no code path that goes back to one, so a restart can only continue forward, never rewind.

## What the platform offers

### Primary source

Tencent publishes the plugin `@tencent-weixin/openclaw-weixin` on npm (`author: "Tencent"`, MIT license, per its own `package.json`). It is an [OpenClaw](https://docs.openclaw.ai) channel plugin implementing this exact protocol, and its version string is exactly what Rome's `CHANNEL_VERSION` constant sends as `base_info.channel_version` on every request. Rome pins `CHANNEL_VERSION = "2.4.3"` (`packages/core/src/channels/wechat.ts:23`), and `2.4.3` is a real, published version of this package. The npm registry lists it among `@tencent-weixin/openclaw-weixin`'s published versions, with `latest` at `2.4.8` as of this research (`https://registry.npmjs.org/@tencent-weixin/openclaw-weixin`). I fetched the exact `2.4.3` tarball from `https://registry.npmjs.org/@tencent-weixin/openclaw-weixin/-/openclaw-weixin-2.4.3.tgz` and read its `README.md` and TypeScript source directly. That tarball is this document's reference client — the same version Rome's adapter targets, not a later or earlier one, and not a third party's description of it.

I also read `https://raw.githubusercontent.com/hao-ji-xing/openclaw-weixin/main/weixin-bot-api.md`, a third-party technical write-up analyzing an earlier version (`1.0.2`) of the same package, and confirmed it describes the same endpoints, the same header set, and the same `context_token` mechanism as the `2.4.3` source. That repository also has an unpacked copy of the `1.0.2` package under `packages/openclaw-weixin/`, whose `session-guard.ts` and `monitor.ts` are byte-for-byte the same logic as `2.4.3`'s (see below). The two versions carry the same protocol for every claim below.

### Full endpoint list (documented)

Tencent's own `README.md`, shipped inside the `2.4.3` npm tarball (`package/README.md`, section "Backend API Protocol"), documents this endpoint table (`https://registry.npmjs.org/@tencent-weixin/openclaw-weixin/-/openclaw-weixin-2.4.3.tgz`, `package/README.md`, "Endpoint List"):

| Endpoint | Path | Description |
|---|---|---|
| getUpdates | `getupdates` | Long-poll for new messages |
| sendMessage | `sendmessage` | Send a message (text/image/video/file) |
| getUploadUrl | `getuploadurl` | Get CDN upload pre-signed URL |
| getConfig | `getconfig` | Get account config (typing ticket, etc.) |
| sendTyping | `sendtyping` | Send/cancel typing status indicator |

The QR-login pair (`get_bot_qrcode`, `get_qrcode_status`) is not in that table — it lives in the plugin's `auth/login-qr.ts`, undocumented in the README's protocol section, but present in Rome's adapter and matching the same paths (`packages/core/src/channels/wechat.ts:408-440`).

The `2.4.3` source (`package/src/api/api.ts`, read from the same tarball) adds two more endpoints not in the public README and not called by Rome's adapter: `ilink/bot/msg/notifystart` and `ilink/bot/msg/notifystop`. Reading `package/src/channel.ts`, these fire once on gateway startup and shutdown (`notifyStart`/`notifyStop`, called around lines 426 and 472 of that file) — a liveness signal to the platform, not a message read. This is inferred from the source, since the shipped README does not document these two paths at all.

**Every endpoint documented or found in source is a command, a login step, or the `getupdates` drain. None reads a message by id, lists conversations, or accepts a starting point other than the opaque cursor.**

### History capability: documented absence, corroborated by code

Tencent's own README (same tarball, "Endpoint List" table above) lists five backend endpoints total and none of them is a history or lookup call. This is the closest thing to a documented statement Tencent publishes: the complete, official list of what a WeChat ClawBot backend must implement has no history endpoint.

The third-party write-up states the absence explicitly, in Chinese, at `https://raw.githubusercontent.com/hao-ji-xing/openclaw-weixin/main/weixin-bot-api.md`, section "八、技术层面的限制与未知" (item 4): "消息历史 — 没有拉取历史消息的 API，只有 `get_updates_buf` 游标机制" ("Message history — there is no API to pull historical messages, only the `get_updates_buf` cursor mechanism"). This is a third party's documented claim, not Tencent's own words, so I tag it **documented (third party)** rather than **documented (Tencent)**.

I also searched the entire `2.4.3` package source and its README/CHANGELOG for any mention of history, backfill, or conversation listing (`grep -rniE "history|backfill" package/`, run against the extracted tarball) and found zero matches anywhere in the plugin. That absence is **inferred from code**, not a documented statement, since nothing in Tencent's shipped material explicitly says "there is no history endpoint" — it is only that no such endpoint exists anywhere in the source that ships the ones that do.

### Cursor behavior: opaque, forward-only, no rewind

Tencent's README documents `get_updates_buf` as an opaque field. The request table calls it a "sync cursor from the previous response," empty on the first request, and the response table calls it the "new sync cursor to pass in the next request" (same tarball, `package/README.md`, "getUpdates" section). Nothing in the README describes a way to set it to an earlier value to reread past messages.

This is corroborated, and narrowed to "no rewind exists," by the reference client's own persistence code. `package/src/storage/sync-buf.ts` (same `2.4.3` tarball) stores only the single latest `get_updates_buf` value on disk, keyed by account, and `loadGetUpdatesBuf`/`saveGetUpdatesBuf` read and write that one value — there is no list of past cursors and no function that returns anything but the most recent one. That the cursor "cannot be rewound" is **inferred from code**: Tencent's docs never say this outright, but nothing in the reference client, the README, or the endpoint list gives a caller any way to get, store, or submit an earlier cursor.

### Retention of undelivered updates

Neither Tencent's README nor the third-party write-ups state how long the platform holds a message that a bot has not yet drained with `getupdates`. This is an open item — see below.

### Retention of message content, and the expectation the bot keeps its own history

Tencent's usage terms for this feature ("微信ClawBot功能使用条款") are reproduced in the third-party repository at `https://raw.githubusercontent.com/hao-ji-xing/openclaw-weixin/main/protocol.md`, signed by "深圳市腾讯计算机系统有限公司" (Shenzhen Tencent Computer Systems Company Limited, the entity that operates WeChat) and dated to a Shenzhen Nanshan District jurisdiction clause. I could not independently confirm this exact text against a Tencent-hosted URL — see Open items — so I tag the following as **documented (third-party reproduction of Tencent's terms)** rather than a directly-fetched Tencent source. Two clauses answer the retention question directly:

- Clause 3.2: "我们仅提供微信ClawBot插件与第三方AI服务的信息收发，不存储你的输入内容与输出结果，不提供AI相关服务。" ("We only offer message transmission between the WeChat ClawBot plugin and the third-party AI service. We do not store your input content or output results. We do not offer AI-related services.")
- Clause 5.2: "我们不会在服务器上保存输入内容与输出结果，你使用本功能产生的信息存储在你的终端设备，你可以自行备份、删除。" ("We do not save input content or output results on our servers. Information your use of this feature produces is stored on your terminal device. You may back it up or delete it yourself.")

Read together with the endpoint list and the cursor mechanics above, these clauses describe a platform that is a message relay with no durable store on its own side, by its own account. Anything a bot wants to answer later about what was said has to live on the bot's side, because Tencent states it keeps nothing on its own servers past the point of delivery.

### Auth model

Login is a QR code scan. `get_bot_qrcode` mints a QR (`?bot_type=3`), the WeChat app on the user's phone scans and confirms it, and `get_qrcode_status` returns a `bot_token` once confirmed (Tencent's README, same tarball, "鉴权流程" / auth-flow section, matched by Rome's `WechatAuthService` at `packages/core/src/channels/wechat.ts:1028-1110`). Every later request carries `Authorization: Bearer <bot_token>`, `AuthorizationType: ilink_bot_token`, and a per-request random `X-WECHAT-UIN` header (Tencent's README, "Common request headers" table, matched by `buildHeaders` at `packages/core/src/channels/wechat.ts:304-318`).

Tencent's README documents `errcode -14` directly, in the `getUpdates` response field table: "`errcode` | `number?` | Error code (e.g., `-14` = session timeout)" (same tarball, `package/README.md`, "getUpdates" → "Response body" table). This is **documented by Tencent**, not inferred. Neither the README nor the source states how long a `bot_token` lives before that error occurs, so the token lifetime itself is undocumented and untested — see Open items.

The reference client's own recovery behavior for `-14` is a fixed one-hour cooldown, hardcoded and not configurable: `package/src/api/session-guard.ts` (same `2.4.3` tarball) defines `SESSION_PAUSE_DURATION_MS = 60 * 60 * 1000` and `SESSION_EXPIRED_ERRCODE = -14`, and pauses all API calls for that account for an hour before it tries again. Rome's adapter copies this behavior with matching constants and a comment naming the source: `STALE_SESSION_ERRCODE = -14`, `SESSION_PAUSE_DURATION_MS = 60 * 60 * 1_000` (`packages/core/src/channels/wechat.ts:35, 37`). This one-hour figure is **inferred behavior from the reference client's source**, not something Tencent's docs state as a rule — it is the reference client's own choice of retry policy, which Rome's comment explicitly says it is matching, not a documented server-side requirement.

The reference client's long-poll loop (`package/src/monitor/monitor.ts`, same tarball) also matches Rome's adapter constant-for-constant: `MAX_CONSECUTIVE_FAILURES = 3`, `BACKOFF_DELAY_MS = 30_000`, `RETRY_DELAY_MS = 2_000` in both `package/src/monitor/monitor.ts` and `packages/core/src/channels/wechat.ts:31-33`, and both persist the sync cursor to a per-account file and resume from it on restart (`package/src/storage/sync-buf.ts` and `packages/core/src/channels/wechat.ts:1439-1441, 1267`). This is the strongest evidence that Rome's adapter is modeled directly on this exact reference client rather than a generic description of the protocol.

## Feasibility of each read

**1. Count of messages with a person.** Not directly. There is no endpoint that reports how many messages exist between the bot and a user id — only `getupdates`, which returns messages not yet delivered and nothing about what has already been delivered and consumed. The only route is a mirror Rome fills as `getupdates` delivers messages, counting rows in its own store.

**2. Latest message with a person.** Not directly. The platform has no "get the most recent message with user X" call. The one moment the platform hands Rome a "latest" fact is the instant `getupdates` delivers it — after that, it is gone from the platform's answer surface. The only route is the same mirror, read for its newest row.

**3. Full read of history with a person.** Not directly, for the same reason as (1) and (2), and confirmed by the explicit absence of any history or lookup endpoint in Tencent's own endpoint list and in the `2.4.3` source. The only route is the mirror holding every message the bot has ever received for that person.

**4. `readConversation` for a given conversation.** Not directly. `group_id` identifies a group in the messages the adapter already normalizes (`packages/core/src/channels/wechat.ts:933-934, 949`), but there is no endpoint that takes a `group_id` (or any conversation id) and returns its messages. The only route is the same mirror, filtered by the conversation's id.

**All four reads reduce to the same requirement: Rome has to store every message it ever receives from WeChat via `getupdates`, in its own database, to answer any of them later. The platform holds nothing to query after the moment of delivery, by its own terms (clause 3.2, clause 5.2 above) and by the complete absence of a lookup endpoint in its own documented and source-level API surface.**

## Open items

- **Undelivered-update retention window.** Neither Tencent's README nor any source read for this document states how long the platform holds a message the bot has not yet drained with `getupdates` — for example, while the bot is offline or between long-poll calls. Resolving this would need either a Tencent-published SLA (not found) or a live test: disconnect a bot token, send it a message from another WeChat account, wait a controlled interval, then reconnect and poll.
- **`bot_token` lifetime.** Tencent's README documents that `errcode -14` means "session timeout" but does not state the duration a `bot_token` is valid for before that happens. Resolving this would need either a Tencent-published figure (not found) or a live test against a real bot token, left running until it expires.
- **Authenticity of the reproduced terms text.** The "微信ClawBot功能使用条款" clauses quoted above come from a third-party repository's `protocol.md`, not from a URL under a Tencent-controlled domain that I could fetch directly. I found a plausible official host for Tencent's rule documents (`https://rule.tencent.com/rule/202603060002`, linked from Tencent's own QClaw open-platform page) but could not retrieve its rendered content through the tools available in this session — the page appears to require client-side rendering. Resolving this would need fetching that page with a tool that executes JavaScript, or locating the specific rule id for the WeChat ClawBot terms.
- **`bot_type=3`'s meaning.** Rome's adapter and every source read for this document hardcode `bot_type=3` on the QR-login call with no explanation of what other values might mean or select. This does not bear on the history question, but is worth flagging as unexplained in every source found.
