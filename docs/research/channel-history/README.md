# Channel history stores: research for issue #182

[Issue #182](https://github.com/rome-os/rome/issues/182) asks where a channel's history store lives when its rows come from the platform rather than the database, and leaves Feishu and WeChat undecided until someone checks what their platforms offer. The five notes here answer those unknowns against primary sources: the repo's code, the private Rome Cloud routes, and each platform's own documentation or reference client.

## The route question

- [store-routes.md](store-routes.md) — the three resolutions, what each changes and risks. Routes 1 and 2 both reduce to how a store obtains a platform client, which the repo already answers three ways, and both then fail the contract's account verbs. Route 3, a mirror per channel, is the only one that leaves the contract alone.
- [email-account-verbs.md](email-account-verbs.md) — whether the account verbs can be answered against the mail provider. `count` cannot be, at any layer. A directory render costs at least two full mailbox walks.
- [discord-rest-history.md](discord-rest-history.md) — what a bot token can read over Discord REST. All four reads are possible for a known direct-message channel, but `count` and the full read pay for walking the channel, and a bot cannot list its open direct-message channels.

## The undecided platforms

- [feishu-history.md](feishu-history.md) — Feishu and Lark expose a chat-scoped history list on the tenant token the adapter already holds, for chats the bot belongs to. All four reads are directly implementable for person-to-bot chats. Group history needs a scope Rome may not have registered.
- [wechat-history.md](wechat-history.md) — the iLink bot platform has no history read of any kind. Tencent's own terms say it stores no content server-side. A mirror is the only route.

## What the notes leave open

- Whether Rome's registered Feishu scopes cover group history. The scope catalog page is script-rendered and the note could not read it.
- The iLink platform's retention of undelivered updates, which no source documents.
- A backfill that satisfies the horizon claim in `docs/northstars/channels.md`. Neither existing mirror sync backfills, so the Discord and email mirrors would need one written fresh.
