# Discord's REST API: what it lets Rome read about history

Discord's bot-token REST API can answer all four reads issue [#182](https://github.com/rome-os/rome/issues/182) asks for — `count`, `latest`, the full read, and `readConversation` — for a direct message channel Rome already knows the id of, with no mirror table. `readConversation` maps onto [Get Channel Messages](https://docs.discord.com/developers/resources/message#get-channel-messages) one page at a time, at the cost the contract already expects: one REST call per page. `latest` is one call, because Get Channel Messages returns newest-first with no cursor. `count` and the full read pay for walking the whole channel in pages of 100, because Discord names no endpoint that returns a message count and the one endpoint that returns a total (Search Guild Messages) excludes direct messages entirely, is a preview Discord's own guidance calls unfit for production, and gates on a privileged intent besides. The one thing a bot cannot do over REST is discover a person's direct-message channel id from nothing — there is no documented endpoint that lists a bot's open DM channels — so a directory-wide read needs each person's Discord user id ahead of time, which Rome's person mapping already carries as the account's address.

## What the adapter does today

`DiscordAdapter.fetchHistory` reads a channel's history through the REST API, not the gateway, given a channel id and a window of hours (`packages/core/src/channels/discord.ts:1368`). It converts the window's start into a snowflake and calls `Routes.channelMessages(channelId)` with `after` and `limit` query parameters (`packages/core/src/channels/discord.ts:1446-1455`). Discord returns messages newest-first. The adapter reverses the page to chronological order and drops messages from other bots before normalizing them (`packages/core/src/channels/discord.ts:1376-1386`).

Called with no channel id, `fetchHistory` instead lists every guild the bot is in (`Routes.userGuilds()`), lists each guild's channels (`Routes.guildChannels(guildId)`), keeps only text-shaped channel types — guild text, announcement, and public and private threads (`packages/core/src/channels/discord.ts:89`) — and pages each one the same way, in parallel (`packages/core/src/channels/discord.ts:1389-1439`). This path never touches direct messages.

The bot token itself is opened when the Discord connection's `talker` capability is built: `creds.bot.material` supplies the token the `DiscordAdapter` constructor takes, and the descriptor requests the `Guilds`, `GuildMessages`, `MessageContent`, `DirectMessages`, and `DirectMessageReactions` gateway intents for the live connection (`packages/core/src/connections/integrations/discord.ts:376-383`, `packages/core/src/channels/discord.ts:372-378`). `TalkHistory.query` wraps `fetchHistory` and slices the result to the caller's limit (`packages/core/src/connections/integrations/discord.ts:429-437`) — this is the one history read the adapter exposes today, and it is windowed by hours, not by the `MessageAccount`/`MessageConversation` shapes `packages/core/src/channels/messages.ts` defines. Discord has no `Messages` implementation. `packages/core/src/channels/channel-list.ts` holds only WhatsApp and LinkedIn.

A Discord user maps to a Rome person by their Discord user id, carried as `channelUserId` off the message author (`packages/core/src/channels/discord.ts:114,819`). A conversation maps to a Discord channel id directly — the same id sent as `threadId` into `sendMessage` and into `fetchHistory`, whether that channel is a DM, a guild text channel, or a thread (`packages/core/src/channels/discord.ts:1272`, the `SendableChannel` union at `packages/core/src/channels/discord.ts:128`). Nothing in the adapter filters a shared channel's messages down to one author — there is no per-person read inside a guild channel, only whole-channel reads.

## What the API offers

### Get Channel Messages

`GET /channels/{channel.id}/messages` requires `VIEW_CHANNEL` and, in guild channels, `READ_MESSAGE_HISTORY` — without the latter no messages come back at all ([Message resource, Get Channel Messages](https://docs.discord.com/developers/resources/message#get-channel-messages)). `limit` defaults to 50 and caps at 100 per call. `before`, `after`, and `around` are mutually exclusive snowflake cursors, and the response is always ordered newest to oldest regardless of which cursor is used. The response carries no count of the channel's total messages — only the page itself.

### Message count and search

No endpoint returns a channel's message count directly. The nearest thing is `GET /guilds/{guild.id}/messages/search` ([Message resource, Search Guild Messages](https://docs.discord.com/developers/resources/message#search-guild-messages)), which filters by `content`, up to 500 `channel_id`s, and up to 100 `author_id`s, sorts by `timestamp` or `relevance`, and returns `total_results` alongside the matching `messages`. It can answer a 202 with `doing_deep_historical_index` while the guild's index catches up, and it is gated by the `MESSAGE_CONTENT` privileged intent the same as any other read of message content.

Discord opened this endpoint to bots as a preview on August 18, 2025, after years of restricting it to user (self-bot) tokens — the discord.py maintainers' own guidance on this changed from "bots do not have access to the search endpoint" (December 2022) to bot access existing "at least now" once the docs were updated (per the discussion at [Rapptz/discord.py#9142](https://github.com/Rapptz/discord.py/discussions/9142)). Community write-ups of the preview describe it as explicitly unfit for production and subject to breaking changes without notice, and scoped to guilds only — it has no direct-message counterpart ([Discord Search API for Bots — Current State](https://gist.github.com/derwells/0575f28ba87fda8ec7d239b649e1c445)). The official docs' own endpoint is guild-scoped by path (`/guilds/{guild.id}/messages/search`), which independently confirms it cannot reach a direct-message channel.

### Direct messages

The Users resource documents `POST /users/@me/channels` for two things: Create DM, which opens a one-to-one DM channel with a user or returns the existing one if it is already open, and Create Group DM, limited to 10 active group DMs and built for the deprecated GameBridge SDK ([User resource, Create DM](https://docs.discord.com/developers/resources/user#create-dm)). Discord's own guidance against Create DM is about pattern, not access: "You should not use this endpoint to DM everyone in a server about something... If you open a significant amount of DMs too quickly, your bot may be rate limited or blocked from opening new ones."

The Users resource documents no `GET` endpoint that lists a bot's existing DM channels. A bot cannot enumerate who it already has open direct-message threads with over REST — the only route in is knowing a user's id up front and calling Create DM, which is idempotent, so calling it again for a person Rome has already messaged returns the same channel rather than opening a new one.

### The `MESSAGE_CONTENT` intent

`MESSAGE_CONTENT` gates message content identically over REST and the gateway. The docs state it plainly: "HTTP API restrictions are independent of Gateway restrictions, and are unaffected by which intents your app passes in the `intents` parameter when Identifying" ([Gateway, Privileged Intents](https://docs.discord.com/developers/topics/gateway#privileged-intents)). The fields it gates are named explicitly — `content`, `embeds`, `attachments`, `components`, and `poll` — and without the intent those fields come back empty on every read, REST included. The intent has to be toggled on for the app in the Developer Portal's Bot page, under Privileged Gateway Intents, separately from what the gateway `Identify` payload requests, and an app that has crossed into needing Discord's verification must be approved for the intent before it can use it at all.

### Guild permissions

Reading a guild channel's history needs `VIEW_CHANNEL` and `READ_MESSAGE_HISTORY` on the bot's effective permissions for that channel ([Topics, Permissions](https://docs.discord.com/developers/topics/permissions)). Denying `VIEW_CHANNEL` implicitly denies everything else scoped to the channel, including message history, regardless of what else is granted.

### Bulk export

Discord documents no bulk export or archive endpoint for a bot to call. Every third-party chat exporter (DiscordChatExporter and similar) works by paging Get Channel Messages itself — there is no shortcut in the API they call into, which is itself evidence the shortcut does not exist.

### Rate limits

Bots share a global ceiling of 50 requests per second across every route ([Topics, Rate Limits](https://docs.discord.com/developers/topics/rate-limits)). Get Channel Messages also sits behind its own per-route bucket, identified by the `X-RateLimit-Bucket` response header, with `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `X-RateLimit-Reset-After` describing that bucket's state on every response. A 429 carries a `Retry-After` the caller is told to honor rather than a fixed pacing baked into the client.

## Feasibility of each read

All four reads are implementable directly over REST for a direct-message conversation whose channel id Rome already holds, with no mirror table. Call that channel's message count `N`.

**`latest(accounts)`** costs one call: `GET .../messages?limit=1` with no cursor returns the single newest message, because the endpoint is always newest-first. This is the cheapest of the four regardless of `N`.

**`count(accounts)`** costs `ceil(N/100)` calls, minimum one, because no endpoint returns a count and the only endpoint that does — Search Guild Messages — cannot reach a direct-message channel at all. The store has to page with `limit=100` and `after` cursors until a page returns fewer than 100 messages.

**The full read** costs the same `ceil(N/100)` calls as `count`, by the contract's own law that `count` is the length of the full read (`packages/core/src/channels/messages.ts:68-95`). Nothing about REST lets a store answer `count` cheaper than the read it counts. `packages/core/src/people/activity.ts:63-64` calls both `count` and `latest` for every person in a directory at once, which for a REST-backed Discord store means one full walk per person, per call.

**`readConversation`** is the one verb whose request shape already matches the endpoint's cursor: `ConversationRead` carries a conversation id, an `after` cursor, and a limit, the same three inputs Get Channel Messages takes. One REST call answers one page, with no forced full-history walk — the cheapest per-page verb of the four, and the only one whose contract does not tie its cost to `N`.

Resolving a DM channel id for a person Rome has never messaged costs one extra `POST /users/@me/channels` call, idempotent whether the channel already exists or not. There is no way to skip this and no way to discover the id any other way over REST.

What none of the four can do at all: answer `count` in one call for a DM (no endpoint returns it), search or filter a DM's messages (Search Guild Messages excludes DMs by path), enumerate the DM channels a bot already has open (no documented `GET`), return message content without `MESSAGE_CONTENT` toggled on for the app, or export a channel's full history in one call.

## Open items

- Whether Search Guild Messages' preview status and guild-only scope rule it out entirely for guild-channel `readConversation`, or whether it is worth using once Discord graduates it out of preview — it answers nothing for the direct-message case either way.
- What `after` cursor value a Discord-backed `readConversation` store should treat as "no cursor" on the first page, since Discord's `after` takes a snowflake and `ConversationRead.after` takes a `TimelineEntry | null`.
- Whether `count`/`latest`/full-read cost scaling with `N` (one walk per call, no caching) is acceptable given `packages/core/src/people/activity.ts:63-64` calls both across a whole directory, or whether a REST-backed store needs its own cache in front of the walk regardless of which resolution issue #182 picks.
