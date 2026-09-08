# Prototype: a Discord mirror store over `sqlMessages`

## The question

Does a Discord mirror store built on [`sqlMessages`](../../../packages/core/src/channels/messages-sql.ts), filled by a backfill that walks the REST API's `Get Channel Messages` paging, pass [`testMessagesContract`](../../../packages/core/src/channels/messages-contract.ts)? Can that backfill satisfy the horizon claim at [`docs/northstars/channels.md:14`](../../northstars/channels.md)? What does the extra key column [store-routes.md](store-routes.md) flags for multi-account keying cost?

## What was built

Two throwaway files, untracked, next to the module they prototype. Neither is wired into `channel-list.ts`, `db/schema.ts`, or any migration.

| File | Lines | Code lines |
| --- | --- | --- |
| [`packages/core/src/channels/discord-messages.prototype.ts`](../../../packages/core/src/channels/discord-messages.prototype.ts) | 235 | 133 |
| [`packages/core/src/channels/discord-messages.prototype.test.ts`](../../../packages/core/src/channels/discord-messages.prototype.test.ts) | 413 | — |

The prototype module holds four pieces. `discordMessagesTable` is 18 code lines of drizzle, `wa_messages` plus two columns. `createDiscordMirrorTable` is 18 lines of raw SQL, so a test creates the table on a `createTestDb()` without a migration. `discordMessages(db, options)` is 28 lines, against 53 for `whatsAppMessages`. `backfillDiscord(db, rest, options)` is 38 lines.

The two extra columns are the finding the note predicted and one it did not. `bot_user_id` is the connected Discord application's own user id, and it sits in the primary key. `dm_user_id` is the counterparty of a direct-message channel, null for a guild channel. The second column exists because Discord keys history by channel and never by author ([`packages/core/src/channels/discord.ts:114`](../../../packages/core/src/channels/discord.ts), `:819`), so no column on a message row says whose account history it belongs to. `wa_messages` needs no equivalent, because a WhatsApp direct chat is addressed by the contact and the chat JID is already the address.

The backfill takes the fake REST client the task named and walks each channel to exhaustion through the `before` cursor. It keeps no watermark. Every run re-walks every channel from the newest message down, and the primary key supplies idempotence through `onConflictDoNothing`.

## What passed

All 65 tests, on the first run for the first 48 and on the first run again after the last 17 were added. `nix develop -c pnpm --filter @rome/core typecheck` exits clean.

```
 ✓ src/channels/discord-messages.prototype.test.ts (65)
 Test Files 1 passed
      Tests 65 passed
   Duration 1.60s (build 75ms, tests 1.52s)
```

Nothing failed. The contract suite ran three times over three configurations of the same store, and passed every time:

```
  ✓ Messages contract: discordMessages prototype > pages to exhaustion over exactly the full read (14ms)
  ✓ Messages contract: discordMessages prototype (unscoped, both bots) > pages to exhaustion over exactly the full read (14ms)
  ✓ Messages contract: discordMessages prototype (unscoped, ref carries account) > pages to exhaustion over exactly the full read (14ms)
```

The third of those three answers a four-message guild channel with eight entries. See below.

## What the contract demanded that the prototype did not anticipate

Nothing. The store passed the suite the first time it ran, seeded through the backfill rather than through hand-written rows. Every obligation `store-routes.md` tabulated is `sqlMessages`' to meet, and a view that names the six columns correctly inherits all of them. The 28-line estimate for a store holds, and the note's "~50-70 lines" is the upper bound rather than the figure.

The suite's demand on the enrolled data is what took the work. Four messages per read with two in the same second, a group the account reads cannot reach, a silent account, and a silent conversation together fix the shape of the seed. A guild channel supplies the group. A direct-message channel supplies the account.

The surprise runs the other way. The contract does not detect a wrong history, only an inconsistent one. Enrolled unscoped with the connected bot in the `ref`, the store reports a four-message guild channel as eight entries and Alice's history as six. The suite passes: `count` still equals the length of the full read, every `ref` is distinct, the pages still exhaust, and nothing after the oldest answers.

```
STATE guild, ref carries account: [
  'bot-a/guild-general:2004',
  'bot-b/guild-general:2004',
  'bot-a/guild-general:2003',
  'bot-b/guild-general:2003',
  'bot-a/guild-general:2002',
  'bot-a/guild-general:2001',
  'bot-b/guild-general:2001',
  'bot-b/guild-general:2002'
]
```

## The answer on horizon

A `before`-cursor backfill reaches the whole channel, and the cost is the page count with no surprise in it.

```
STATE backfill run: { calls: 4, seen: 350, written: 350 } cursors: [
 {"channelId":"horizon-channel","limit":100},
 {"channelId":"horizon-channel","before":"10250","limit":100},
 {"channelId":"horizon-channel","before":"10150","limit":100},
 {"channelId":"horizon-channel","before":"10050","limit":100}]
STATE horizon read: 350 horizon-channel:10349 horizon-channel:10000
```

The store then answers all 350, oldest included, so the history reaches the channel's first message rather than the sync's start. The northstar claim is satisfiable this way, for a channel whose id Rome already holds.

The REST call count is `ceil(N/100)`, except when 100 divides `N`, where the walk pays one extra call. `Get Channel Messages` returns no total, so a short page is the only end-of-history signal, and an exactly full last page cannot be told from a full page with more behind it.

| Messages in the channel | REST calls |
| --- | --- |
| 0 | 1 |
| 1 | 1 |
| 99 | 1 |
| 100 | 2 |
| 101 | 2 |
| 200 | 3 |
| 350 | 4 |

Rerunning the backfill is idempotent, and a rerun after new messages picks them up:

```
STATE first: { calls: 4, seen: 350, written: 350 } rerun: { calls: 4, seen: 350, written: 0 }
STATE after growth: { calls: 4, seen: 353, written: 3 }
```

The cost of that idempotence is the whole walk. The rerun made the same four calls and read the same 350 messages to write none of them. A `before`-only walk cannot stop early on a rerun, because it starts at the newest message and the rows it has already seen are the ones at the far end. A production sync needs two cursors: an `after` walk forward from the newest mirrored message for the catch-up, and a stored floor snowflake for the backward backfill, so the backfill resumes below the floor instead of restarting above it.

## The answer on multi-account keying

The extra column is cheap. Deciding what the store does with it is not.

Scoped to one connected bot, the store keeps two bots apart cleanly:

```
STATE scoped A: [ 'dm-a-alice:1004', 'dm-a-alice:1002', 'dm-a-alice:1003', 'dm-a-alice:1001' ]
scoped B: [ 'dm-b-alice:3002', 'dm-b-alice:3001' ]
```

That store is a per-connection object, and `Channel` has nowhere to put one. Contract C1 at [`packages/core/src/channels/channel.ts:24`](../../../packages/core/src/channels/channel.ts) says one channel per name and one name per channel, stable for the life of the deployment, because the name is written on every stored row. A list holding one entry per connected bot breaks C1. A list holding one entry named `discord` cannot hold a scoped store.

Unscoped, the store fits the list as it stands and merges the two bots. Alice's separate conversations with each bot become one six-entry history:

```
STATE unscoped account read: [
  'dm-a-alice:1004', 'dm-b-alice:3002', 'dm-a-alice:1002',
  'dm-a-alice:1003', 'dm-b-alice:3001', 'dm-a-alice:1001' ]
```

For the account read, that merge is arguably right. `MessageAccount` names a person by their addresses on a channel, and what passed between Rome and Alice on Discord did pass on Discord, whichever bot carried it. For a guild channel both bots sit in, the merge is wrong, and it is wrong in a way that survives every defense in the code. Both connections mirror the same four messages under the same channel id and the same message ids. Leaving `bot_user_id` out of the `ref` lets `sqlMessages`' `SELECT DISTINCT` fold the copies back to one — for every message except the one bot A sent:

```
STATE guild scoped: 4 unscoped: [
 {"timestamp":760,"direction":"inbound","ref":"guild-general:2004",…},
 {"timestamp":750,"direction":"inbound","ref":"guild-general:2003",…},
 {"timestamp":700,"direction":"outbound","ref":"guild-general:2002",…},
 {"timestamp":700,"direction":"inbound","ref":"guild-general:2001",…},
 {"timestamp":700,"direction":"inbound","ref":"guild-general:2002",…}]
```

`from_me` is `author_id = bot_user_id`, so bot A's own message is outbound in bot A's mirror and inbound in bot B's. Direction is a projected column, so the `DISTINCT` cannot reach across it, and the conversation shows five entries for a four-message channel with one message appearing twice under opposite directions. Putting the bot in the `ref` gives eight. Leaving it out gives five. Neither is four.

So the cost is not the column. The cost is that `outbound` stops being a fact about a message and becomes a fact about a message and a viewer, and no shape of a single `discord` channel entry holds both. Three ways out are open, and the prototype does not pick among them. Scope the mirror to one connected bot per deployment and take the C1 problem off the table by making it not arise. Give `Channel` a per-account dimension and take the C1 change. Or make the sync itself elect one connection per channel to mirror, so the shared guild channel has one mirror row per message and `outbound` has one answer.

## Verdict

**A Discord mirror store over `sqlMessages` works, and the store is the easy part.** The store is 28 code lines and passed the contract suite on the first run, seeded through the backfill rather than through fixtures. Route 3's claim about store size holds and is conservative.

**The backfill satisfies the horizon claim.** A `before`-cursor walk reaches the whole channel at `ceil(N/100)` calls, and the prototype reads back all 350 messages of a 350-message channel, oldest first message included. The open item store-routes.md named is closed for Discord, at the cost of a second cursor for the catch-up direction that the prototype does not have.

**Multi-account keying is the real cost, and it is not a column.** Adding `bot_user_id` to the table is 1 line. Deciding what the store does with two connections that mirror one guild channel is a design question with no cheap answer, because `outbound` is per connection and the contract's `TimelineEntry` has one `direction`. The contract suite catches none of it: the store that reports a four-message channel as eight entries passes every assertion in the suite.

**A production version would still need:** a second, `after`-direction cursor and a stored backfill floor, so a rerun does not re-walk the history. A `discord_channels` table carrying the direct-message counterparty, rather than the denormalized `dm_user_id` column the prototype writes onto every message row. `POST /users/@me/channels` to resolve a direct-message channel id for a person Rome has not messaged, since no endpoint lists a bot's open direct-message channels ([discord-rest-history.md](discord-rest-history.md)). Rate-limit handling for the 50-per-second global ceiling and per-route buckets. Live persist hooks on the gateway path, the way WhatsApp mirrors at [`packages/core/src/channels/whatsapp.ts:228`](../../../packages/core/src/channels/whatsapp.ts). A decision on which connection mirrors a shared guild channel. And the `MESSAGE_CONTENT` intent, without which every mirrored `content` is an empty string and the mirror stores a history with no words in it.
