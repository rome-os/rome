# Channel history stores: research for issue #182

[Issue #182](https://github.com/rome-os/rome/issues/182) asks where a channel's history store lives when its rows come from the platform rather than the database, and leaves Feishu and WeChat undecided until someone checks what their platforms offer. The five notes here answer those unknowns against primary sources: the repo's code, the private Rome Cloud routes, and each platform's own documentation or reference client.

## The route question

- [store-routes.md](store-routes.md) — the three resolutions, what each changes and risks. Routes 1 and 2 both reduce to how a store gets a platform client, which the repo already answers three ways, and both then fail the contract's account verbs. Route 3, a mirror per channel, is the only one that leaves the contract alone.
- [email-account-verbs.md](email-account-verbs.md) — whether the account verbs can be answered against the mail provider. `count` cannot be, at any layer. A directory render costs at least two full mailbox walks.
- [discord-rest-history.md](discord-rest-history.md) — what a bot token can read over Discord REST. All four reads are possible for a known direct-message channel, but `count` and the full read pay for walking the channel, and a bot cannot list its open direct-message channels.

## The undecided platforms

- [feishu-history.md](feishu-history.md) — Feishu and Lark expose a chat-scoped history list on the tenant token the adapter already holds, for chats the bot belongs to. All four reads are directly implementable for person-to-bot chats. Group history needs the sensitive `im:message.group_msg` scope, which a follow-up section confirms Rome does not register.
- [wechat-history.md](wechat-history.md) — the iLink bot platform has no history read of any kind. Tencent's own terms say it stores no content server-side. A mirror is the only route. A follow-up section verifies the reference client against the npm registry and settles the error code.

## Prototypes

Each prototype enrolled a throwaway store in the contract suite in `messages-contract.ts`, which is the ground truth for what a store must satisfy. The code lived beside the real stores as `*.prototype.ts` files and is not part of this change. Each note records the question, the test output, and a verdict.

- [prototype-discord-mirror.md](prototype-discord-mirror.md) — route 3 for Discord. A 28-line store over `sqlMessages` passes the whole suite, and a `before`-cursor backfill reaches the oldest message, so the horizon claim is met. The real cost is keying: history is per channel, never per author, so two bots sharing a channel disagree on which messages are outbound, and the suite cannot see that.
- [prototype-email-mirror.md](prototype-email-mirror.md) — route 3 for email. The store passes the whole suite. Attribution must resolve at read time, because the newest-first walk meets a thread's outbound rows before the inbound row that names the person. Using the thread's counterparty and falling back to one fetch per unanswered outbound thread costs 8 body fetches where a per-message strategy costs 164. The suite cannot see bad attribution either, because an unattributed account reads as a silent one.
- [prototype-feishu-direct.md](prototype-feishu-direct.md) — route 2 for Feishu. Thirty-nine of forty-one cases pass. The two failures are one law: `latest` from a one-message page picks the wrong entry whenever the newest second holds more than one message, because the timeline ranks an outbound reply above the inbound line it answers within a tied second. Reading the whole newest second fixes it. Cost is the constraint: one directory pass over fifty accounts made 300 calls against a fifty-per-second ceiling.

## What the notes leave open

- Feishu's message retention window. No page in the Feishu or Lark docs states one, and the only time-shaped rule found is the membership check.
- The iLink platform's retention of undelivered updates. Tencent's client, its README and five community sources say nothing.
- An official host for the WeChat terms clause about server-side storage. The candidate page turned out to be a different document.
- Whether `outbound` can stay a fact about a message once two Discord bots share a channel, or whether the store has to be scoped per bot and the one-channel-per-name contract has to give.
- A contract case that catches misattribution. Both mirror prototypes show the suite accepts a store that silently drops a person's history.
