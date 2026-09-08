# Where a channel store lives when its rows come from the platform

Routes 1 and 2 are two answers to one question — how a `Messages` store gets a platform client — and the repo already answers that question three ways, so neither route buys much. Both then hit the same wall, which is the contract rather than the wiring: `count` is the length of the full read and `latest` is its first entry ([`packages/core/src/channels/messages.ts:75-95`](../../../packages/core/src/channels/messages.ts)), and `packages/core/src/people/timeline.ts:113-121` asks `latest` once per account across a whole directory. Neither Discord's REST API nor the mail provider offers a per-account query or an unbounded walk, so a store over either can answer none of the three account verbs at their stated cost. Route 3 is the only one of the three that leaves the contract alone, and its cost is roughly 800 to 1,100 non-test lines per channel over machinery that already exists. Its one documented obligation is the backfill horizon at [`docs/northstars/channels.md:14`](../../northstars/channels.md).

## The list today, and who reads it

`channelList` returns a two-entry literal built from the database and two prebuilt address books (`packages/core/src/channels/channel-list.ts:29-38`). `packages/core/src/index.ts:242` calls it. The connection registry appears at `packages/core/src/index.ts:281`, descriptors register later, and capabilities start at `packages/core/src/index.ts:1054`. `Channels` is a `readonly Channel[]` (`packages/core/src/channels/channel.ts:87`) whose own doc says a list is built once for every caller that reads it (`packages/core/src/channels/channel.ts:71-74`).

Every reader of the message stores reads the list per call. One reader snapshots it.

| Reader | Where it reads | Capture |
| --- | --- | --- |
| `createAccountNames` | `packages/core/src/channels/account-names.ts:77-81` | Once. `addressBooks(deps.channels)` becomes a `Record` at construction, from `packages/core/src/index.ts:243`. |
| `ApiDeps.channels` | `packages/core/src/api/deps.ts:80`, filled at `packages/core/src/index.ts:1229` | Holds the array reference. Routes read `deps.channels` per request. |
| `personMessageStores` | `packages/core/src/people/timeline-sources.ts:46-47` | Per call. |
| `timelineAccounts` and `booksNamed` | `packages/core/src/people/timeline-sources.ts:65-82` | Per call. |
| `readAccountDirectory` and `readAccountStream` | `packages/core/src/people/account-directory.ts:177` | Per call. |
| Test kit | `packages/core/src/test/helpers.ts:416-417` | Once, mirroring boot. |

The request-time entry points are `packages/core/src/api/routes/people.ts:165` and `:169`, `packages/core/src/api/routes/accounts.ts:56` and `:76`, `packages/core/src/people/resource.ts:75` and `:81`, and `packages/core/src/people/account-decisions.ts:167`.

Three mechanisms already let a boot-time object reach a live connection. `ConnectionRegistry.onUnlocked(cap, handler)` fires per unlock epoch and fires immediately for connections already unlocked (`packages/core/src/connections/registry.ts:600-605`). `ConnectionRegistry.find(service)` plus `Connection.talk` is read at request time by an existing route (`packages/core/src/connections/registry.ts:358`, `:844-848`, `packages/core/src/api/routes/discord-cli.ts:107`). A plain mutable ref set on connection-up already serves the prompt builder for email (`packages/core/src/index.ts:426`, read through a closure at `:431`, set at `:976`).

## Resolution 1: the list stops being built once

### What changes

- `packages/core/src/channels/channel.ts:87` — `Channels` gains a lifecycle. The list becomes an object with `subscribe` or a live view rather than a `readonly Channel[]`. `packages/core/src/apps/catalog.ts:106` is the in-repo precedent for the subscriber shape.
- `packages/core/src/channels/channel.ts:71-87` and `packages/core/src/channels/channel-list.ts:1-28` — the doc comments state the once-built property as a contract and both have to be rewritten.
- `packages/core/src/channels/account-names.ts:77-81` — the one true snapshot. `AccountNames` folds `addressBooks` into a `Record` at construction, so a channel registered later never reaches display names until this reads the list per call.
- `packages/core/src/index.ts:242-243` and `:1229` — the build site, and the point the list enters `ApiDeps`.
- `packages/core/src/connections/integrations/discord.ts:372-400` — the descriptor's talker build registers the store, since that is where `creds.bot.material` opens (`packages/core/src/connections/integrations/discord.ts:377`).
- `packages/core/src/connections/registry.ts:600` — or, instead of touching the descriptor, one `onUnlocked("talk", …)` handler in `packages/core/src/index.ts` registers a store per epoch.
- `packages/core/src/test/helpers.ts:416-417` and `packages/core/src/people/timeline-sources.test.ts` — every test that hands a literal array as `Channels`.

### What it risks

The registered store must not outlive its grant epoch. `docs/adrs/channels-and-connectors-are-one-connection.md:51` states that "no handle survives its grant epoch", and `:41` states that "a caller wires per unlock epoch through the registry rather than holding a handle for the process lifetime". A store built inside a talker build and pushed onto a list is exactly the handle that outlives the epoch unless a relock removes it. The registry fires `onUnlocked` before the instance starts and rebuilds the capability on every conferral, renewal, and credential change (`packages/core/src/connections/registry.ts:988`, `:1105`), so the deregistration path is as much work as the registration path.

A list that changes under a read produces two answers to one question. `packages/core/src/people/timeline.ts:84-131` assigns each account to the first store that answers a `latest` for it, and `packages/core/src/people/resource.ts:75-81` raises `timelineAccounts` and `readPeopleActivity` from one serialize call. A channel that appears between those two reads gives a row an owner the page beneath it does not have.

Route 1 relocates the platform client and settles nothing else. The store a connection registers still answers `count` and `latest` against the platform, so it inherits the whole of resolution 2's problem below. The three mechanisms listed above already deliver a platform client to a boot-time object, so the lifecycle change buys the store nothing the registry does not already offer.

## Resolution 2: a channel store may hold more than the database

### What the contract obliges

`packages/core/src/channels/messages.ts:75-95` states one law over the three account-scoped verbs. Call the full read the `read` with no cursor and a limit large enough to hold everything. Then `count` is the length of that read and `latest` is its first entry. `packages/core/src/channels/messages-contract.ts:17` fixes the limit that means "large enough" at `Number.MAX_SAFE_INTEGER`.

The suite asserts twelve obligations per store, and every one again for `readConversation`:

| Obligation | Assertion |
| --- | --- |
| `latest` equals the first entry of the full read | `packages/core/src/channels/messages-contract.ts:64-68` |
| `count` equals the length of the full read | `packages/core/src/channels/messages-contract.ts:70-74` |
| `latest` equals `read` with a limit of one | `packages/core/src/channels/messages-contract.ts:76-80` |
| A page is newest first and holds at most its limit | `packages/core/src/channels/messages-contract.ts:82-87` |
| A page holds only entries strictly after the cursor | `packages/core/src/channels/messages-contract.ts:89-100` |
| Paging to exhaustion walks exactly the full read | `packages/core/src/channels/messages-contract.ts:102-122` |
| Nothing answers after the oldest message | `packages/core/src/channels/messages-contract.ts:124-135` |
| Every message has its own cursor position | `packages/core/src/channels/messages-contract.ts:137-143` |
| A silent account answers null, zero, and an empty page | `packages/core/src/channels/messages-contract.ts:145-153` |
| The conversation read owes the same order, cursor, and exhaustion | `packages/core/src/channels/messages-contract.ts:160-233` |

Five stores are enrolled: `agentMessages`, `sentinelLogMessages`, `linkedInMessages`, `whatsAppMessages`, and `memoryMessages` (`packages/core/src/channels/messages-agent.test.ts:347`, `messages-sentinel.test.ts:191`, `linkedin-messages.test.ts:333`, `whatsapp-messages.test.ts:238`, `messages-memory.test.ts:71`).

The callers set the cost. `assignAccountHeads` calls `store.latest([account])` once per unclaimed account per store, raising the whole store's worth before awaiting any (`packages/core/src/people/timeline.ts:113-121`). `readAccountStream` runs that over the entire address book in rounds of a thousand addresses (`packages/core/src/people/account-directory.ts:92-99`, `:130`). `readPeopleActivity` raises one `count` and one `latest` per person per store in one pass (`packages/core/src/people/activity.ts:62-65`). `sqlMessages` meets that shape by folding every job raised in one tick into a single statement, with `count` and `read` read off one window (`packages/core/src/channels/messages-sql.ts:97-120`, `:282-291`).

Neither platform offers a query of that shape. Discord keys history by channel and never by author: `channelUserId` is the message author id (`packages/core/src/channels/discord.ts:114`, `:819`), and `fetchHistory` takes a thread id or walks every channel of every guild (`packages/core/src/channels/discord.ts:1367-1400`). It caps each channel at 100 messages and cuts by a time window rather than a cursor (`packages/core/src/channels/discord.ts:1368-1373`). The mail provider's `ListMessagesParams` carries `after`, `before`, `limit`, `ascending`, and `pageToken`, and no sender filter (`packages/core/src/lib/rome-cloud-mail.ts:121-132`), so a per-account read means walking the mailbox and matching `from` in Rome. `fetchHistory` truncates at 200 matched messages, 2,000 scanned, and 50 pages (`packages/core/src/channels/email.ts:130-143`, `:585-601`).

The history the two already expose is a window read, not a ranking. `TalkHistory.query` takes `conversationId`, `since`, and `limit` (`packages/app-runtime-sdk/src/index.ts:1434-1439`), and the shared helper clamps the limit to 1,000 and the window to hours (`packages/core/src/connections/integrations/talk-features.ts:62-72`, `:112-124`). Discord implements it at `packages/core/src/connections/integrations/discord.ts:430-436` and email at `packages/core/src/connections/integrations/email.ts:299-303`. So a window read exists for both channels and answers none of `count`, `latest`, exhaustion, or "nothing after the oldest".

`memoryMessages` proves a store outside SQL can pass the suite (`packages/core/src/channels/messages-memory.ts:43-57`). It does so by holding every message and sorting the whole list, which is the full materialization a paged remote source is trying to avoid.

### What changes

- `packages/core/src/channels/messages.ts:75-95` — the law relaxes, or the two channels get an exemption. Either way the sentence that binds a preview to the page beneath it changes.
- `packages/core/src/channels/messages-contract.ts:64-153` — the assertions a remote store cannot meet come out or become conditional, for a suite whose stated purpose is that the law is asserted once rather than per adapter (`packages/core/src/channels/messages-contract.ts:1-4`).
- `packages/core/src/people/timeline.ts:67-73` — the ownership rule derives from `latest` alone. A store whose `latest` is bounded by a window claims an account it cannot page.
- `packages/core/src/people/activity.ts:62-71` — `messageCount` becomes an estimate for two channels, and `PersonActivity` documents `latest` as null exactly when `messageCount` is zero (`packages/core/src/people/activity.ts:20-25`).
- `packages/core/src/channels/channel-list.ts:29-38` — the factory takes a way to reach a platform client. Nothing new is needed to supply one: `registry.find(service)` plus `Connection.talk` (`packages/core/src/connections/registry.ts:358`, `:844`), `onUnlocked` (`:600`), `TalkRouter.feature` (`packages/core/src/connections/talk-router.ts:55`), or a mutable ref of the kind at `packages/core/src/index.ts:426`.
- Email alone needs no credential work. `RomeCloudMailProvider` resolves the instance token per request (`packages/core/src/lib/rome-cloud-mail.ts:197-212`) and is already constructed at boot (`packages/core/src/index.ts:975`).
- New rate limiting and caching. `readAccountStream` would raise one remote `latest` per address per round of a thousand (`packages/core/src/people/account-directory.ts:130`).

### What it risks

Every People read becomes as slow and as failure-prone as the platform. `packages/core/src/api/routes/accounts.ts:76` serves the account stream from `readAccountStream`, and `packages/core/src/api/routes/people.ts:48` serves the people listing from `readPeople`. Both would fan out to Discord or to the mail provider once per account. `packages/core/src/channels/channel.ts:8-12` states the reason the read side is apart from the transport: a directory read that had to be live would make every People read depend on whether the guardian's phone is reachable.

Relaxing the law reopens the disagreement it was written to close. `packages/core/src/channels/messages.ts:84-86` states that a store answering the three verbs on their own terms could preview an entry its own pages never show, and `packages/core/src/people/timeline.ts:67-73` states that a separate "do you hold this" answer is free to disagree with the first. A conditional contract gives four stores one law and two another.

The relaxation is not confined to the two new channels. `Messages` is one interface, and the assertion that comes out of `messages-contract.ts` comes out for `agentMessages` and `sentinelLogMessages` too.

## Resolution 3: platform-calling channels get a mirror

### The pattern to copy

Both mirrors are the same five pieces. A platform producer feeds a `*SyncSink` data contract, a repository upserts into channel-specific tables, a `Messages` view reads them, and an `Accounts` fold reads the same tables. The sink is injected into the descriptor at `packages/core/src/connections/integrations/index.ts:117` and `:123` from `packages/core/src/index.ts:957-958`.

The store itself is small because `sqlMessages` is channel-agnostic. `whatsAppMessages` is 53 lines, of which 21 are the SQL view (`packages/core/src/channels/whatsapp-messages.ts:32-53`). `linkedInMessages` is 69 (`packages/core/src/channels/linkedin-messages.ts:26-67`). The 435 lines of paging, cursor, count, and batching in `packages/core/src/channels/messages-sql.ts` are already paid for.

The tables are channel-specific and live in `packages/core/src/db/schema/system.ts`: `wa_contacts` (`:132`), `wa_chats` (`:146`), `wa_messages` (`:156`, composite primary key at `:179`, one index at `:180`), `linkedin_threads` (`:191`), `linkedin_messages` (`:226`), `linkedin_participants` (`:256`), and `linkedin_thread_participants` (`:274`). Seven migrations created them, together under 3 KB.

The two sync triggers differ. WhatsApp writes from Baileys events registered in `start()` — live upserts at `packages/core/src/channels/whatsapp.ts:228-231`, a connect-time history blob at `:267-279`, contacts at `:280-288`, and chats at `:290-293`. Its backfill is whatever WhatsApp hands a newly linked device under `syncFullHistory: true` (`packages/core/src/channels/whatsapp.ts:129-138`), with no window, no cursor, and no stored watermark. A reconnect rebuilds the socket and re-registers every handler (`packages/core/src/channels/whatsapp.ts:205-215`), and re-arriving rows land on the composite primary key. LinkedIn polls instead, on a jittered 15-to-30-minute interval (`packages/core/src/channels/linkedin.ts:60-62`, `:330-336`, `packages/core/src/config.ts:39-40`), reads its watermarks before upserting (`packages/core/src/channels/linkedin.ts:161-163`), and snapshots at most six stale threads of 25 messages per tick (`packages/core/src/channels/linkedin.ts:33-34`, `:181-192`). Its watermark lives in the mirror itself, as `linkedin_threads.last_synced_at` (`packages/core/src/db/repositories/linkedin-store.ts:227-250`).

Outbound is mirrored on WhatsApp by re-delivery rather than by the send path: `sendMessage` writes nothing, and Baileys re-delivers the sent frame through `messages.upsert`, which mirrors every message including `fromMe` (`packages/core/src/channels/whatsapp.ts:230-232`, `:1274`). LinkedIn has no send path at all (`packages/core/src/connections/integrations/linkedin.ts:338-342`).

### What changes

Per channel, for Discord and again for email:

- `packages/core/src/db/schema/system.ts` — a messages table and a threads table, plus a migration in `packages/core/drizzle/system/`. Roughly 35 SQL lines, on the evidence of `0029_chilly_eddie_brock.sql` and `0054_yielding_night_thrasher.sql`.
- A `*-sync.ts` data contract beside `packages/core/src/channels/whatsapp-sync.ts` (71 lines) and `packages/core/src/channels/linkedin-sync.ts` (147 lines).
- A repository beside `packages/core/src/db/repositories/whatsapp-store.ts` (433 lines) and `packages/core/src/db/repositories/linkedin-store.ts` (594 lines).
- A `Messages` view beside `packages/core/src/channels/whatsapp-messages.ts` (53 lines).
- Persist hooks in the adapter. WhatsApp's are `packages/core/src/channels/whatsapp.ts:228-346`, about 120 lines.
- Two lines each in `packages/core/src/channels/channel-list.ts:34-37`, `packages/core/src/index.ts:957-958`, and `packages/core/src/connections/integrations/index.ts:117-123`.
- A contract enrollment beside `packages/core/src/channels/whatsapp-messages.test.ts:238`.

That comes to roughly 800 to 1,100 non-test lines per channel, and about 1.4 times that in tests, on the measured size of the two existing paths. Nothing above the list moves. `Channels`, `Messages`, the contract suite, and every reader in the table above stay as they are.

### What it risks

The horizon claim is the binding one. `docs/northstars/channels.md:14` states that "a channel says what was said on it, as far back as its platform lets Rome read", and `docs/northstars/channels.md:5` states that what a channel cannot answer "is a limit of its platform, never a limit of what has been built". A mirror whose history starts at first sync answers back to the sync, not to the platform's horizon, and the shortfall is exactly the limit that sentence forbids. So the sync owes a real backfill, and neither existing sync is one to copy — WhatsApp takes whatever the platform pushes, and LinkedIn reaches only the newest 25 messages of the top 40 threads.

Discord fits neither template. It has a push surface and real cursor pagination, so a backfill needs a `before`-cursor loop with a per-channel watermark. That machinery exists nowhere in the repo.

Email's unit is a thread with mutable labels and read state, and it has no `sender_is_self` analog. The nearest precedent is LinkedIn's mutable-message upsert (`packages/core/src/db/repositories/linkedin-store.ts:198-205`) rather than WhatsApp's immutable one (`packages/core/src/db/repositories/whatsapp-store.ts:251-259`).

Both existing mirror tables assume one connected account per channel — neither `wa_messages` nor `linkedin_messages` carries an account or connection column (`packages/core/src/db/schema/system.ts:156-177`, `:226-246`). Discord spans guilds and email spans mailboxes, so both need an extra key column, which is a departure from the pattern rather than a copy of it.

A mirror is a second copy that can fall behind without failing. The repo has rejected that shape three times on other subjects, and the reasoning transfers even though the records do not bind here: `docs/adrs/fork-params-derived-from-live-open-over-enumerated-mirror.md:27`, `docs/adrs/child-session-owns-subagent-stream-and-cost.md:26` and `:42`, and `docs/adrs/provider-agnostic-relay-over-edge-verification.md:29`.

Storage grows with mailbox and guild volume. `docs/adrs/conversation-identity-from-channel-address-not-session-lifetime.md:39` treats that as a retention policy somebody designs in the open rather than as a defect.

## Constraints in the docs and the ADRs

No ADR covers where a channel message store lives. The 24 records in `docs/adrs/` name none of the three routes, and `docs/architecture/channels.md` is 13 lines covering connection setup only. What exists is four standing constraints that bear on the routes without deciding among them.

`docs/adrs/channels-and-connectors-are-one-connection.md:51` binds route 1: "A capability handle is non-null if and only if the capability is implemented, all the grants it needs are live, and a subscription-gated Watch has an active subscription. Nothing gates the handle on a runtime connectivity check, and no handle survives its grant epoch." The same record at `:41` states that "a caller wires per unlock epoch through the registry rather than holding a handle for the process lifetime", which sanctions a changing list and requires a deregistration path.

`docs/adrs/brokered-provider-capability-over-token-handoff.md:47` bounds route 2: "The credential behind a brokered capability stays in the Core process. It reaches no Rome-authored tool through arguments, environment, stdin, a config file, a `$HOME` store, or a projected runtime file, and not through a client object that carries one." A store living inside Core is on the sanctioned side of that line. A client object handed onward is not.

`docs/northstars/channels.md:16` bounds route 2 the other way: "A channel says who it reaches and what was said on it without its message transport." Discord reads history over REST and email over the mail provider's HTTP client, so neither is the transport, and both satisfy the statement. The Telegram personal session does not, since MTProto is both.

`docs/northstars/channels.md:14` and `:5` bound route 3, as quoted above. `docs/concepts/messaging.md:11` states the same force in the concepts family: "A platform that keeps its own record has the conversation back past the point Rome started watching. Where Rome keeps the only record, the history starts when Rome did."

One statement binds all three routes equally. `docs/concepts/messaging.md:28` states that "what a conversation holds and what passed between Rome and a person are two questions to one store, not two histories: a channel answers both from the record it already keeps."

`docs/adrs/conversation-identity-from-channel-address-not-session-lifetime.md:32` is the nearest thing to a rejection of a live platform read, and it is about a different use: "**Fetch a replied-to message from the platform API when a turn needs it, generalizing the Discord prompt workaround.** Rejected because it works only on platforms that offer a live fetch, depends on the model choosing to call a tool, and assumes the original message stays readable." The named force generalizes to route 2. The record never generalizes it in writing.

## Open items

Whether the People listing can live without an exact `messageCount` is a product question the code cannot settle. `packages/core/src/people/activity.ts:20-25` ties `latest` to `messageCount` being zero, and `packages/core/src/api/routes/people.ts:48` serves the number to the dashboard. If an estimate is acceptable there, route 2 loses its hardest obligation and becomes affordable for email.

How far back Discord and the mail provider let Rome read is not in the code. Discord's REST API pages backward without a stated floor, and the mail provider's `after` parameter carries no documented horizon (`packages/core/src/lib/rome-cloud-mail.ts:122`). The northstar horizon claim cannot be checked against either until somebody measures.

Whether a mirror-backed store should still be registered by its connection is independent of the choice among the three. Route 1's lifecycle change composes with route 3, and the reason to take it would be the epoch rule at `docs/adrs/channels-and-connectors-are-one-connection.md:51` rather than anything about where rows come from.

Whether Feishu and WeChat offer a history at all decides whether they reach any of these routes. No adapter in `packages/core/src/channels/` reads one, and the answer is a fact about the platforms.
