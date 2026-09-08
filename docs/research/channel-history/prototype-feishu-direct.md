# Prototype: a Messages store answered directly from Feishu, with no mirror

## The question

Does a `Messages` implementation that answers every verb from a Feishu-shaped paged API pass `testMessagesContract` with no mirror behind it? [`feishu-history.md`](feishu-history.md) claims all four reads are "directly implementable against the API for p2p history, with no mirror required for correctness", and states that "`latest` is one call with `page_size: 1` descending". This prototype enrolls that claim in the contract suite and counts the API calls the directory pattern costs.

## What was built

Two files, left untracked next to the module they prototype.

- [`packages/core/src/channels/feishu-messages.prototype.ts`](../../../packages/core/src/channels/feishu-messages.prototype.ts), 360 lines. A `FeishuClient` interface declaring only `im.message.list`, shaped after `@larksuiteoapi/node-sdk@1.68.0` (`types/index.d.ts:257375-257425`): `container_id`, `start_time`/`end_time` in whole seconds, `sort_type`, `page_size`, `page_token`, answering `{ code, msg, data: { has_more, page_token, items } }`. `feishuMessages(client, chatIdOf, options)` answers all four verbs by calling it. `fakeFeishu(chats)` pages a fixed set of chats the way the docs describe, clamps `page_size` to 1-50, ranks by the millisecond `create_time` the API returns, answers 230002 for a chat it does not hold, and counts every call and every item.
- [`packages/core/src/channels/feishu-messages.prototype.test.ts`](../../../packages/core/src/channels/feishu-messages.prototype.test.ts), 241 lines. Two enrollments in `testMessagesContract`, seeded the way `messages-memory.test.ts` seeds the reference store, plus six behavior tests and three call-count tests.

The store holds no rows. `read` and `readConversation` walk `im.message.list` descending, `count` walks it to exhaustion, and `latest` runs whichever strategy the enrollment names.

## Which contract cases pass and which fail

Thirty-nine of forty-one tests pass. The two failures are the same law asked twice, and both belong to the enrollment that answers `latest` the way the note claims.

```
 Test Files 1 failed
      Tests 2 failed | 39 passed (41)

 FAIL  Messages contract: feishuMessages, latest as the note claims
       > answers latest as the first entry of the full read
 FAIL  Messages contract: feishuMessages, latest as the note claims
       > answers latest as a read of one
```

Both report the same disagreement:

```
- Expected                    + Received
  {                             {
-   "body": "a3",             +   "body": "a4",
-   "direction": "outbound",  +   "direction": "inbound",
-   "ref": "a3",              +   "ref": "a4",
    "source": "feishu",           "source": "feishu",
    "timestamp": 300,             "timestamp": 300,
  }                             }
```

The reason is an ordering disagreement inside one second, and it is systematic rather than incidental. `TimelineEntry.timestamp` is whole epoch seconds ([`packages/api-types/src/people.ts:203-209`](../../../packages/api-types/src/people.ts)), and `compareTimelineEntries` settles a tied second on direction, ranking an outbound message above an inbound one ([`packages/api-types/src/people.ts:232-238`](../../../packages/api-types/src/people.ts)). The comment there states the intent: a reply Rome sent sits above the line it answers. Feishu ranks by `create_time` in milliseconds, so it puts that reply below. A `page_size: 1` descending call returns the platform's newest message, which is the wrong entry whenever the newest second holds more than one message. The contract requires enrolling a same-second pair, so this is the case the suite exists to catch.

Every other law passes, including the six the note does not discuss: page order, the strictly-after-cursor rule, paging to exhaustion, nothing after the oldest message, one cursor position per message, and the same five over `readConversation`. They pass because the walk never commits an answer until every unfetched message is provably in an older second than the last entry it would return. A store that returned the API's first page as its own page would fail the order law. The prototype proves that separately: with `page_size` set to 2 against a chat whose second spans a page boundary, the correct two-entry page is `[d5, d2]`, and the API returns `d4` where `d2` belongs.

Reconciling `latest` fixes both failures. The second enrollment answers `latest` by pulling until the whole newest second is in hand, then ranking it Rome's way, and passes all sixteen cases. So the law is reachable. It is one call plus a full page rather than one call plus one message, and against a chat whose newest second spans a page it is more than one call.

## What the calls cost

Measured against a directory of 50 accounts, each with one p2p chat of 250 messages, at the API's `page_size` ceiling of 50.

| Pattern | Calls | Message items |
| --- | --- | --- |
| `latest` per account, one call each, as the note claims | 50 | 50 |
| `latest` per account, reconciled | 50 | 2,500 |
| `count` per account | 250 | 12,500 |
| One `readPeopleActivity` pass, one `count` and one `latest` per account | 300 | 12,550 |

`count` is five calls a person, because 250 messages at 50 a page is five pages and the API offers no count-shaped endpoint. The 300-call figure is what [`packages/core/src/people/activity.ts:62-65`](../../../packages/core/src/people/activity.ts) raises in one tick for 50 people. Feishu caps a tenant at 50 requests a second, so that pass cannot finish in under six seconds however it is scheduled, and it moves 12,550 messages to answer 50 integers and 50 previews. `sqlMessages` answers the same pass in one statement ([`packages/core/src/channels/messages-sql.ts:97-120`](../../../packages/core/src/channels/messages-sql.ts)).

The account stream is the harder caller. `readAccountStream` raises `latest` over a thousand addresses a round ([`packages/core/src/people/account-directory.ts:130`](../../../packages/core/src/people/account-directory.ts)), which is a thousand calls, or twenty seconds at the platform ceiling, to render one page of a directory.

## Whether the chat-id map answers the account verbs

A chat id learned from an inbound message answers the account verbs correctly for every account the map has heard of. It answers them wrongly, and silently, for every account it has not.

`GET /open-apis/im/v1/chats` excludes p2p chats, so a person's chat id arrives only on a message. An address the map does not hold reaches no chat, so the store makes zero API calls and answers null, zero, and an empty page. The prototype asserts exactly that. Those are the same three answers a genuinely silent account gets, and the contract gives no fourth answer to tell them apart: `latest` returning null is how a caller learns the store holds nothing, and `messages.ts:87-89` states there is no `holds` verb by design. `assignAccountHeads` reads the null as "this store does not hold this account" ([`packages/core/src/people/timeline.ts:113-121`](../../../packages/core/src/people/timeline.ts)), so a person whose Feishu history exists on the platform reads as a person with no Feishu history until they send a message.

The map is therefore a mirror, kept in a different shape. It has to be durable, it starts empty, and its coverage grows only as people write in. Nothing in the adapter stores one today: `listObservedConversations` holds group chats in memory since start, and never adds a p2p chat ([`packages/core/src/channels/feishu.ts:242-247`](../../../packages/core/src/channels/feishu.ts), `:314-316`).

One further conflation shows up in `readConversation`. The contract states that a conversation the store has never heard of and one it holds empty get the same answer, an empty page ([`packages/core/src/channels/messages-contract.ts:222-234`](../../../packages/core/src/channels/messages-contract.ts)). The platform tells those two apart with error 230002 for a chat the bot may not read. The prototype maps 230002 to an empty page to satisfy the law, which reports a permission failure to a caller as an empty conversation.

## Verdict

**The note's claim is qualified, not wrong.** Route 2 is correctness-reachable for Feishu p2p history, and this prototype is a working `Messages` that passes all sixteen contract cases with no mirror. Three of the note's four statements hold as written. The fourth does not.

1. **`readConversation`, full `read`, and `count` are directly implementable.** They pass the contract unchanged. `count` costs the full paged walk the note predicts.
2. **`latest` is not one call with `page_size: 1` descending.** That implementation fails two contract laws, because Feishu's create-time order and `compareTimelineEntries` disagree inside every second holding more than one message, and Rome's order inverts chronology for a reply on purpose. The fix is a page rather than a message, and more than one call when the newest second spans a page.
3. **"No mirror required for correctness" holds only past the chat-id map.** The map is state Rome keeps, it starts empty, and no platform call rebuilds it. An account missing from it is indistinguishable from an account with no history, which is a wrong answer the contract has no way to report.
4. **Correctness was never the binding constraint. Cost is.** One `readPeopleActivity` pass over 50 people is 300 calls and 12,550 messages against a 50-per-second ceiling, and one page of the account stream is a thousand calls. Both are answered by one SQL statement in every store that exists today.

Reading these four together, a Feishu store shaped like route 2 needs a durable chat-id map, a reconciled `latest`, and a cache in front of the account verbs. At that point it holds message state, which is route 3 reached by a longer path.

## Open items

- `end_time` is assumed inclusive. The cursor walk seeks by setting `end_time` to the cursor's own second, which drops the boundary second if the platform treats the bound as exclusive. The docs state the unit and not the inclusivity, and the fake models it as inclusive.
- The prototype drops a message marked `deleted`. `im.message.get` refuses one with 230110, so counting it would count what no page can render. Whether `im.message.list` returns deleted messages at all is unverified.
- Group history stays behind the sensitive `im:message.group_msg` scope that Rome does not request, so the `readConversation` cases pass against a fake that serves a group Rome may not be able to read. The scope gap is the open item in [`feishu-history.md`](feishu-history.md), and this prototype does not close it.
- The 250-messages-a-person fixture is a guess. Real call counts scale linearly with real history depth, so a person with 5,000 messages costs 100 calls for one `count`.
