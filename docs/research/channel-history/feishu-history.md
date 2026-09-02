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

- **Group-history scope gap unconfirmed.** Rome's registered scopes include `im:message.group_msg:readonly`, `im:message.group_at_msg:readonly`, and `im:message.group_at_msg.include_bot:readonly`. The docs name the scope that unlocks full group history as `im:message.group_msg` (no `:readonly` suffix), described as a separate, sensitive permission. Whether `im:message.group_msg:readonly` is the same scope under a different display name, a distinct narrower scope, or simply absent from the platform's real scope catalog could not be confirmed — the interactive scope-list page (`https://open.feishu.cn/document/ukTMukTMukTM/uYTM5UjL2ETO14iNxkTN/scope-list`) renders its content client-side and returned empty to a non-JS fetch. This only affects group-chat history. p2p history is unaffected, since Rome already holds `im:message:readonly`.
- **`@larksuiteoapi/node-sdk` is not installed in this worktree.** `packages/core/node_modules` does not exist here (no `pnpm install` has run in this checkout). The SDK type citations above come from `1.68.0` — the version pinned in this worktree's own `pnpm-lock.yaml` (`pnpm-lock.yaml:242`, `:3288`) — installed in a sibling worktree at the same commit lineage, so the version matches even though the path does not.
- **No documented retention window.** Both docs pages state the membership rule but no explicit "messages older than N days are unavailable" limit. Absence of a stated limit is not proof no limit exists, only that this pass did not find one in either doc.
- **Rate limit headroom unverified against Rome's usage pattern.** 50 requests/second is generous for one bot's occasional history reads, but a directory-wide `count`/`latest` walk over many guardians' p2p chats at once was not checked against that ceiling.
