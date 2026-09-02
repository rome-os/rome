# Prototype: an email mirror over `sqlMessages`

## The question

Does an email mirror store over [`sqlMessages`](../../../packages/core/src/channels/messages-sql.ts), filled by a backfill that walks the paged `MailProvider.listMessages` and by a writer on the inbound push, pass [`testMessagesContract`](../../../packages/core/src/channels/messages-contract.ts)?

And how does the mirror attribute a message to a person when a list row carries no `to` ([`packages/core/src/lib/rome-cloud-mail.ts:110-119`](../../../packages/core/src/lib/rome-cloud-mail.ts)) — by thread, by a `getMessage` per outbound row, or by both — at what cost in provider calls?

[Route 3 of the store-routes note](store-routes.md) and [the email account-verbs note](email-account-verbs.md) are what this prototype checks.

## What the prototype builds

Two throwaway files, left untracked beside the modules they prototype.

[`packages/core/src/channels/email-messages.prototype.ts`](../../../packages/core/src/channels/email-messages.prototype.ts), 383 lines:

- `email_messages_proto`, one row per mailbox message, and `email_threads_proto`, one row per thread that holds a counterparty. Both are declared with drizzle in the SQLite dialect the system schema uses, and `createEmailMirrorTables` creates them with raw DDL because a prototype has no migration.
- `emailMessages(db)`, a `Messages` store over `sqlMessages`, in the [`whatsAppMessages`](../../../packages/core/src/channels/whatsapp-messages.ts) shape.
- `backfillEmail(db, provider, options)`, a newest-first walk of `listMessages` with one of three attribution strategies.
- `ingestInboundEmail(db, event)`, the writer that hangs off the HMAC-verified push at [`packages/core/src/channels/email.ts:431`](../../../packages/core/src/channels/email.ts), taking the same `RomeMailEvent` that handler gets.
- `FakeMailProvider`, which implements all five `MailProvider` operations, clamps a page to 100 the way the cloud route does, hands back an opaque numeric `pageToken`, and emits a list row with no `to` and no body.

[`packages/core/src/channels/email-messages.prototype.test.ts`](../../../packages/core/src/channels/email-messages.prototype.test.ts), 244 lines. The fake mailbox holds 350 messages across 40 threads and 12 correspondents. Thread 39 belongs to a correspondent of its own, holds 8 messages, and every one of them is outbound — the unanswered thread Rome started. The other 39 threads alternate inbound and outbound, and every thread puts two of its messages in the same second.

## What passed

Every test passed on the first run. No test failed.

```
 ✓ src/channels/email-messages.prototype.test.ts (30)
  ✓ email mirror prototype > backfills the whole mailbox off the paged list (30ms)
  ✓ email mirror prototype > is idempotent across a rerun (24ms)
  ✓ email mirror prototype > costs 0 getMessage calls under thread attribution (17ms)
  ✓ email mirror prototype > costs 164 getMessage calls under message attribution (19ms)
  ✓ email mirror prototype > costs 8 getMessage calls under both attribution (17ms)
  ✓ email mirror prototype > attributes the unanswered thread to 0 messages under thread (18ms)
  ✓ email mirror prototype > attributes the unanswered thread to 8 messages under message (18ms)
  ✓ email mirror prototype > attributes the unanswered thread to 8 messages under both (17ms)
  ✓ email mirror prototype > attributes every answered correspondent under thread (24ms)
  ✓ email mirror prototype > attributes every message of the mailbox to somebody under both (19ms)
  ✓ email mirror prototype > dedupes a push-ingested message against its backfilled copy (17ms)
  ✓ Messages contract: emailMessages (prototype) > answers count as the length of the full read (17ms)
  ✓ Messages contract: emailMessages (prototype) > pages to exhaustion over exactly the full read (20ms)
  ✓ Messages contract: emailMessages (prototype) > gives every message its own cursor position (16ms)
  ✓ Messages contract: emailMessages (prototype) > holds nothing for a silent account (17ms)

 Test Files 1 passed
      Tests 30 passed
   Duration 1.26s (build 79ms, tests 1.18s)
```

All 16 contract assertions passed, the 10 account-scoped ones and the 6 conversation-scoped ones. The backfill reached all 350 messages, a rerun left the row count at 350 and the store's answers byte-identical, and a message ingested by the push writer and then found again by the backfill produced one row and one timeline entry.

`pnpm typecheck` reports nothing on either file.

## The attribution strategies and what they cost

Let M be the messages in the mailbox, O the outbound messages among them, and U the outbound messages in threads that hold no inbound message. The page cap is 100, so a walk is `ceil(M / 100)` list calls. Here M is 350, O is 164, and U is 8.

| Strategy | List calls | `getMessage` calls | Unanswered thread |
| --- | --- | --- | --- |
| `thread` | 4 | 0 | Attributed to nobody |
| `message` | 4 | 164 | Correct |
| `both` | 4 | 8 | Correct |
| Any, on a rerun | 4 | 0 | Correct |

`thread` reads the counterparty off the thread's inbound messages, so it pays nothing and answers 0 messages for the correspondent whose only thread nobody answered. `message` calls `getMessage` for every outbound row and reads `to[0]`, which is `O` calls. `both` calls `getMessage` only for an outbound row whose thread holds no inbound message, which is `U` calls.

`both` is `thread`'s cost plus a call per message in an unanswered thread, and it gives `message`'s answer. On this mailbox that is 8 calls against 164 for the same result, and U falls to zero on a mailbox where every thread got a reply.

A rerun of any strategy costs the walk and no hydration, because a row that already carries a recipient is never fetched again.

Two findings about the walk itself. The provider offers no sender filter, so the backfill is the whole mailbox or nothing — there is no cheaper walk for one person. And attribution has to resolve at read time rather than at write time: the walk runs newest-first, so a thread's outbound rows are mirrored before the inbound row that names the person they belong to, and threads of 8 or 9 messages straddle a page of 100 constantly. The store's account view keys an outbound row by `coalesce(m.to_address, t.counterparty)` over a `LEFT JOIN` to the thread table, which costs nothing and does not care what order the walk found things in.

## What the contract demanded that the prototype did not anticipate

The suite demands that the enrolled account's full read and the enrolled conversation each hold at least four messages, with at least two of them in the same second ([`messages-contract.ts:57-61`](../../../packages/core/src/channels/messages-contract.ts), and again at `:163-167`). A generated mailbox with one message per second fails both. The fake mailbox had to put two positions of every thread in the same second on purpose.

`ref` must be unique across everything the store can put on one timeline. `whatsAppMessages` and `linkedInMessages` both qualify their platform id with the conversation id, so the email view looked like it owed the same. It does not: `providerMessageId` is unique within an inbox, so the view uses it bare.

The silent-account law turns out to be what makes an unattributed outbound row safe. The account view keys such a row NULL, and `key IN (…)` is never true for NULL, so the row reaches no account read at all. The store still answers `count` of 0, `latest` of null and an empty page for the correspondent, which is exactly what `holds nothing for a silent account` asks for. The same row still reaches a conversation read, which the prototype asserts separately. So the `thread` strategy loses a person's history quietly rather than failing the suite — the contract does not catch bad attribution, and a test has to.

## What a production version would still need

1. Decide what `body` holds. The mirror stores the list row's preview, because the list carries no body. Hydrating the real Markdown costs one `getMessage` per message, which is M calls on the first walk and swamps every attribution figure in the table above.
2. Add a write on the send path. `EmailAdapter.sendMessage` knows the recipient and gets back both `messageId` and `threadId` ([`packages/core/src/channels/email.ts:352-367`](../../../packages/core/src/channels/email.ts)), so a mirror writer there attributes an outbound message for free. That leaves `both` covering only the outbound mail the backfill finds, and U shrinks to the unanswered threads that predate the mirror.
3. Add a watermark. The prototype re-walks the whole mailbox and leans on the primary key for idempotency. `listMessages` takes `after`, so a watermark on the newest mirrored `received_at` bounds a rerun to what arrived since.
4. Handle mutable labels and read state. The prototype upserts with `onConflictDoNothing`, so a label change never reaches the mirror. LinkedIn's mutable-message upsert is the nearer precedent.
5. Handle several recipients. The prototype reads `to[0]`. A message addressed to several people belongs to several histories, and `MessageViewSql` already lets one row answer under several keys.
6. Carry the push path's authentication gate. `ingestInbound` namespaces mail that fails authentication under `unauthenticated:` ([`packages/core/src/channels/email.ts:487`](../../../packages/core/src/channels/email.ts)), and the prototype keys an inbound row by the raw From address.
7. Confirm the rate limits. 350 messages is 4 list calls. A mailbox of 100,000 is 1,000 calls on a 15-second timeout each, and neither the SDK types nor the endpoint reference states a per-inbox budget.
8. Add the pieces route 3 lists around the store: a migration, a repository, an `Accounts` implementation, and an entry in `channelList`.

## Verdict

The mirror works. An email store over `sqlMessages`, filled by a paged backfill and an inbound-push writer, passes all 16 obligations of `testMessagesContract` with no change to the contract, to `Messages`, or to `sqlMessages`. Nothing above the store moves.

Build `both` attribution. It answers as well as a `getMessage` per outbound message at a small fraction of the calls — 8 against 164 on a mailbox of 350 — and it is the only strategy of the three that attributes an unanswered thread Rome started. Attributing by thread alone is cheaper by 8 calls and drops a correspondent's whole history without failing anything.

The cost that decides the shape of a production backfill is not attribution. It is the body: attribution under `both` is a handful of calls, and hydrating bodies is one call per message in the mailbox.
