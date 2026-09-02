# Feishu / Lark message history: what the platform offers

Feishu's Open Platform (mirrored, in English, on Lark's international docs at the same URL path) does let a bot read message history, through `GET /open-apis/im/v1/messages` — but only for a chat the bot is currently a member of, and the bot is a member of every p2p chat it appears in by construction, so the p2p case Rome needs is unrestricted by that rule. The call runs on the tenant access token the adapter already mints from `appId`/`appSecret`, needs one of three scopes Rome's registered app already holds for p2p (`im:message:readonly`, granted) plus a separate sensitive scope for group history that Rome has not requested, pages by time range and cursor with no per-sender filter, and carries no documented retention window narrower than "the bot must be in the chat." `GET /open-apis/im/v1/chats` lists the bot's group memberships but excludes p2p chats outright, so a person's p2p `chat_id` is only ever learned from an inbound message, never listed. Direct implementation is possible for `readConversation` and for the three person-scoped reads over p2p history. None of the four reads needs a local mirror, but `count` and `latest` need a full paged walk of the chat because the API offers no `count`-shaped or `sender`-scoped endpoint.

## What the adapter does today

`FeishuAdapter` (`packages/core/src/channels/feishu.ts:108`) wraps the SDK's high-level `LarkChannel`, built with `transport: "websocket"` (`packages/core/src/channels/feishu.ts:129-140`). It authenticates with `appId`/`appSecret` — the custom-app credential pair, not a per-user OAuth token — and the SDK mints a tenant access token from that pair internally (`packages/core/src/connections/integrations/feishu.ts:369-386` shows the same pair used to call `client.auth.v3.tenantAccessToken.internal` directly, during credential validation). The adapter receives inbound messages over the SDK's long-connection WebSocket via `channel.on("message", ...)` (`packages/core/src/channels/feishu.ts:152-154`). There is no webhook endpoint and no polling.

The adapter identifies a person by `senderId`, the Feishu open ID surfaced on the normalized SDK event (`packages/core/src/channels/feishu.ts:278`), and a conversation by `chatId` (`packages/core/src/channels/feishu.ts:280`, `m.chatType === "p2p" | "group"` at `:237`). It never calls a history-reading endpoint: `handleMessage` only reacts to live events, `sendMessage` only posts, and the SDK calls the adapter makes are `channel.on`, `channel.connect`/`disconnect`, `channel.send`, `channel.addReaction`/`removeReaction` (`packages/core/src/channels/feishu.ts:152-219`). `listObservedConversations` (`:314-316`) returns only the in-memory `Map` of group chats seen since the adapter started (`:242-247`) — nothing durable, and p2p chats are never added to it.

The connection integration (`packages/core/src/connections/integrations/feishu.ts`) registers the scopes Rome's agent app requests at creation time, in `feishuRegistrationAddons` (`:394-417`):

```
im:chat:read
im:message.group_msg:readonly
im:message.group_at_msg.include_bot:readonly
im:message.group_at_msg:readonly
im:message.p2p_msg:readonly
im:message:readonly
im:message.reactions:write_only
im:message:send_as_bot
im:message:update
```

## What the platform offers

### `GET /open-apis/im/v1/messages` (`im.message.list`)

Feishu's server docs — https://open.feishu.cn/document/server-docs/im-v1/message/list, "获取会话历史消息" — describe an endpoint that lists the history of one chat or thread:

- Parameters: `container_id_type` (`chat` or `thread`, required), `container_id` (required), `start_time`/`end_time` (Unix seconds, unsupported for `thread`), `sort_type` (`ByCreateTimeAsc` default or `ByCreateTimeDesc`), `page_size` (1-50, default 20), `page_token`.
- Auth: `tenant_access_token` or `user_access_token` (Authorization: `Bearer <token>`).
- Scopes, any one of: `im:message` (send + read), `im:message:readonly` (read), or `im:message.history:readonly` — Rome's app already holds `im:message:readonly`.
- Group history also needs the sensitive scope `im:message.group_msg` ("获取群组中所有消息") per the same page. Without it, the interface default is p2p-only. Rome's registered addons hold `im:message.group_msg:readonly`, `im:message.group_at_msg:readonly`, and `im:message.group_at_msg.include_bot:readonly` — narrower scopes than `im:message.group_msg`, so group history beyond @-mentions is not confirmed reachable with what Rome requests today (see Open items).
- Membership: "机器人必须在群组中" — the bot must be a member of the chat being queried, or the call fails with error 230002 ("The bot can not be outside the group"), per the docs page and per the community bug report at https://github.com/larksuite/openclaw-lark/issues/356. A bot is inherently a party to every p2p chat that reaches it, so this rule does not block Rome's own p2p history. It only gates group chats the bot has not joined.
- Retention: the docs state no retention window or "only after join" cutoff beyond the membership rule itself.
- Rate limit: 1000 requests/minute, 50 requests/second, stated on the same page.
- No per-sender filter exists on this endpoint — it pages one chat's full timeline by time range and cursor, and a caller filters by sender client-side.

The SDK's type definitions confirm the shape (`node_modules/@larksuiteoapi/node-sdk/types/index.d.ts:257362-257420` in a sibling worktree's install — see Open items on why this worktree has none installed): `im.message.list(payload)` takes `params: { container_id_type, container_id, start_time?, end_time?, sort_type?, page_size?, page_token?, ... }` and resolves `{ code, msg, data: { has_more, page_token, items: [...] } }`. Its inline doc comment reproduces the same Chinese text as the web page: "获取会话（包括单聊、群组）的历史消息（聊天记录）… 获取消息时，机器人必须在群组中 … 接口级别权限默认只能获取单聊（p2p）消息，如果需要获取群组（group）消息，应用还必须拥有**获取群组中所有消息**权限." A `listWithIterator` sibling (same file, immediately preceding `list`) wraps the same call as an `AsyncGenerator`, auto-advancing `page_token`.

### `GET /open-apis/im/v1/messages/:message_id` (`im.message.get`)

https://open.feishu.cn/document/server-docs/im-v1/message/get, "获取指定消息的内容": fetches one message by id. Same auth (tenant or user access token) and the same scope family as `list` (`im:message`, `im:message:readonly`, or `im:message.history:readonly` for p2p, plus `im:message.group_msg` for group messages). Same membership rule — "机器人必须在消息所属的群组内." Same rate limit, 1000/min and 50/sec. It cannot retrieve a deleted message (error 230110). The SDK exposes it as `im.message.get({ path: { message_id }, params: { user_id_type?, card_msg_content_type? } })` (`index.d.ts:257266-257299`).

### `GET /open-apis/im/v1/chats` (`im.chat.list`)

https://open.feishu.cn/document/server-docs — "获取用户或机器人所在的群列表": lists the groups the token holder (bot or user) belongs to — `chat_id`, name, owner, status, and similar metadata. The docs are explicit that **p2p chats are excluded**: "获取到的群列表中，不包含单聊（群模式为 `p2p`）." Scopes, any one of: `im:chat`, `im:chat:readonly`, `im:chat:read`, or `im:chat.group_info:readonly` — Rome's app already holds `im:chat:read`. Auth accepts tenant or user access token. The SDK exposes `im.chat.list({ params: { user_id_type?, sort_type?, page_token?, page_size? } })` returning `{ items: [...], page_token, has_more }` (`index.d.ts:255913-255946`), plus a `searchWithIterator`/`search` pair for a filtered, paged variant with the same p2p exclusion.

Because `chat.list` never surfaces p2p chats, the only way Rome learns a p2p `chat_id` for a given person is from an inbound message it already received on that chat. There is no platform call that enumerates every p2p chat the bot is in.

### China vs. international docs

The Lark international server docs live at the same path under `open.larksuite.com` (e.g., `https://open.larksuite.com/document/server-docs/im-v1/message/list`) and describe the identical parameters, scopes, membership rule, and rate limit — the fetch against that path returned the same structure as the Feishu page, just natively in English rather than machine-translated. No functional difference surfaced for this question. `FeishuConfig.domain` (`packages/core/src/channels/feishu.ts:28-30`) picks the tenant's host (`open.feishu.cn` vs. `open.larksuite.com`) but the two are the same API.

### The SDK's transport seam

`LarkChannel` (the object `FeishuAdapter` wraps) exposes `readonly rawClient: Client` (`index.d.ts:301209-301211` in the sibling install), the low-level SDK client with the full `im.message.*` / `im.chat.*` surface reachable as `channel.rawClient.im.message.list(...)`, `channel.rawClient.im.message.get(...)`, `channel.rawClient.im.chat.list(...)`. `LarkChannel` also exposes convenience wrappers `getChatInfo(chatId)` and `getChatMode(chatId): Promise<'p2p' | 'group' | 'topic'>` (same file, adjacent to `rawClient`) built on `im.chat.get`. The adapter already holds a `LarkChannel` instance (`this.channel`, `packages/core/src/channels/feishu.ts:110`), so no new SDK dependency or client construction is needed to call these. Only new methods on `FeishuAdapter` that reach through `this.channel.rawClient` are needed.

## Feasibility of each read

The `Messages` contract (`packages/core/src/channels/messages.ts:143-161`) binds `count` to the length of the unlimited full `read`, and `latest` to that full read's first entry — both over a set of `MessageAccount`s (a person's addresses on the channel) — while `readConversation` reaches one `MessageConversation` addressed by chat id regardless of who is on it.

- **`readConversation`** — direct. `im.message.list` with `container_id_type: "chat"`, `container_id: <chatId>`, `sort_type: "ByCreateTimeDesc"`, and `page_token` paging answers this exactly: one chat, one paged timeline, no aggregation across accounts. p2p and group chats the bot has joined both work. Membership is guaranteed for p2p and satisfied for group by definition of the bot being addressable there.

- **Full `read` for a person (the account-scoped case)** — direct, for p2p. A person's Feishu account is a single p2p chat with the bot (the p2p `chat_id` learned from any inbound message on it, per `packages/core/src/channels/feishu.ts:280`), so `read` reduces to the same `im.message.list` call as `readConversation`, filtered to the account's own `chat_id`. `MessageAccount.addresses` for Feishu would hold that `chat_id`. There is no cross-chat merge to do, since a person has exactly one p2p chat with the bot.

- **`count`** — direct but not O(1): the API has no count endpoint, so answering `count` means walking the full paged history of the account's p2p chat (`has_more`/`page_token`) and counting items. `latest` — direct and cheap: `sort_type: "ByCreateTimeDesc"`, `page_size: 1` returns the newest message in one call, satisfying the contract's "first entry of the full read" without walking anything.

- **Directory-wide `count`/`latest`** (`packages/core/src/people/activity.ts:63-64`, called per the issue body): each person's `count` still means one paged walk of their p2p chat, and there is no batch/multi-chat variant of `im.message.list`. It is one call sequence per person, not the single pass a SQL-backed store answers in.

None of the four reads is blocked by the platform, and a database mirror is not required for correctness. A mirror would still be worth building for two reasons the docs surface: `count` costs a full paged walk per person with no cheaper platform primitive, and the group-history scope gap below means group-history reads (if ever exposed as account or conversation history) are unconfirmed without a broader, sensitive scope grant.

## Open items

- **`@larksuiteoapi/node-sdk` is not installed in this worktree.** `packages/core/node_modules` does not exist here (no `pnpm install` has run in this checkout). The SDK type citations above come from `1.68.0` — the version pinned in this worktree's own `pnpm-lock.yaml` (`pnpm-lock.yaml:242`, `:3288`) — installed in a sibling worktree at the same commit lineage, so the version matches even though the path does not.
- **Rate limit headroom unverified against Rome's usage pattern.** 50 requests/second is generous for one bot's occasional history reads, but a directory-wide `count`/`latest` walk over many guardians' p2p chats at once was not checked against that ceiling.
- **The scope-list catalog page still could not be read.** `https://open.feishu.cn/document/ukTMukTMukTM/uYTM5UjL2ETO14iNxkTN/scope-list` renders its table via a client-side `<md-scope-list>` component with no static fallback, confirmed again via a direct fetch and via an `r.jina.ai` reader pass — both returned the page shell with no scope rows. The group-history scope finding below rests on three other primary sources instead (see "Follow-up").

## Follow-up: scopes and retention

### Group-history scope: confirmed gap

Refetching https://open.feishu.cn/document/server-docs/im-v1/message/list directly (not through the script-rendered scope-list page) surfaces the endpoint's own permission section. For **app identity** (tenant access token, what Rome uses):

- Base, any one of: `im:message` ("获取与发送单聊、群组消息"), `im:message:readonly` ("获取单聊、群组消息"), `im:message.history:readonly` ("获取单聊、群组的历史消息").
- Group messages also require `im:message.group_msg` ("获取群组中所有消息") — no `:readonly` suffix — described as a further permission layered on top of the base one, not an alternative to it.
- For **user identity** (user access token — not Rome's auth mode): base `im:message`/`im:message:readonly`, plus `im:message.p2p_msg:get_as_user` for p2p or `im:message.group_msg:get_as_user` for group. This family is irrelevant to Rome's tenant-token calls.

The SDK's bundled doc comment on `im.message.list` (`@larksuiteoapi/node-sdk@1.68.0`, found in a sibling repo's worktree at `node_modules/.pnpm/@larksuiteoapi+node-sdk@1.68.0.../types/index.d.ts:257366-257372` — version confirmed to match this worktree's own `pnpm-lock.yaml:242-244`. No install of the package exists under this repo's own `node_modules` in any worktree.) It reproduces the same requirement verbatim: "接口级别权限默认只能获取单聊（p2p）消息，如果需要获取群组（group）消息，应用还必须拥有**==获取群组中所有消息==**权限."

Cross-checked against Feishu's scope-migration notice, https://open.feishu.cn/document/platform-notices/platform-updates-/message-and-group-scope-removed ("消息与群组「更新应用创建群聊的信息」、「读取群信息」等权限点下线"): it retires `im:message.p2p_msg`, `im:message.group_at_msg`, `im:message.groups`, and `im:chat.group_info:readonly` in favor of `im:message.p2p_msg:readonly`, `im:message.group_at_msg:readonly`, `im:chat:operate_as_owner`, and `im:chat:read`/`im:chat.members:read` respectively. That page describes `im:message.group_at_msg` as "获取用户在群组中@机器人的消息" — receiving messages where a user @-mentions the bot — which is an event-delivery scope (gating what arrives over `im.message.receive_v1`), not the `message/list` REST endpoint's history scope. Neither `im:message.group_msg` nor `im:message.group_msg:readonly` appears anywhere on that migration notice.

Putting the two documents together, `im:message.group_msg` (the `message/list` REST scope) and `im:message.group_at_msg` / `im:message.group_at_msg:readonly` (the event-delivery scope for @-mentions) are two separately-documented permission points, and no source found in this pass shows a `:readonly` variant of `im:message.group_msg` existing at all — not the endpoint page, not the SDK's doc comments, not the migration notice, not community write-ups of the full scope set for Feishu bots (e.g. a batch-import permission list at https://oneclaw.cn/docs/tutorials/feishu-bot.html, which names `im:message`, `im:message.group_at_msg:readonly`, `im:message.p2p_msg:readonly`, and others, but not `im:message.group_msg` or a `:readonly` form of it).

Per-scope verdict against `feishuRegistrationAddons()` (`packages/core/src/connections/integrations/feishu.ts:394-417`):

- `im:message:readonly` — **covered**: one of the three documented base options for `message/list`, sufficient for p2p.
- `im:message.p2p_msg:readonly` — redundant with `im:message:readonly` for this endpoint. It is not itself required by `message/list`.
- `im:message.group_msg:readonly` — **not covered**: not the scope name any source ties to `message/list`'s group-history requirement (`im:message.group_msg`, no suffix).
- `im:message.group_at_msg:readonly` — **not covered** for this purpose: documented as the migrated event-delivery scope for @-mention group messages, a different permission point than `message/list`'s group-history scope.
- `im:message.group_at_msg.include_bot:readonly` — same family as above, event delivery rather than REST history.
- `im:chat:read` — covers `chat.list`, not `message.list`.

Conclusion: **p2p history is covered** by `im:message:readonly`. **Group history is not covered** — Rome's registration holds no scope matching `im:message.group_msg`, the one every primary source names as required for `im/v1/messages` to return group-chat messages. This upgrades the earlier "unconfirmed" finding to a confirmed gap. The one residual limit: the platform's own interactive scope catalog page still could not be read (see Open items), so the verdict rests on the endpoint doc, the SDK's bundled comments, and the migration notice agreeing with each other rather than on the catalog itself.

### Retention: still no documented window, checked against a second source

No retention or history-depth statement appears on the `message/list` page in this pass either. One additional primary source was checked: the community bug report at https://github.com/larksuite/openclaw-lark/issues/356 ("Bug: feishu_im_user_get_messages 无法读取用户私聊消息"), which confirms the only time-shaped restriction documented anywhere is the membership rule — error `230002`, "The bot can not be outside the group" — triggered when a bot calls `message.list` against a chat (p2p or group) it is not currently a party to. That is a membership check, not a stated cutoff on how far back within a chat the bot can read once it is a member. No source found in this pass — the `message/list` page, the `message/get` page, the SDK's bundled doc comments, or the openclaw-lark issue — states messages become unreadable after a retention period, or that history is truncated to "since the bot joined." Absence of a stated limit remains not proof no limit exists.

### Bonus: no message search API for bots

The full `im.message.*` surface, enumerated from the SDK's bundled types (`@larksuiteoapi/node-sdk@1.68.0`): `batch_query`, `create`, `delete`, `forward`, `get`, `list`, `merge_forward`, `patch`, `push_follow_up`, `read_users`, `reply`, `update`, `urgent_app`/`urgent_phone`/`urgent_sms`. None searches by keyword or by sender across chats — `list`, paged one `container_id` at a time, remains the only way to read history, which holds up the base research's finding that `count` has no cheaper platform primitive. The only "search"-named endpoint in the `im-v1` namespace is `im.chat.search` (https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat/search, "Search for groups visible to a user or bot") — it searches chat/group metadata, not message content, and does not change `count`'s cost.
