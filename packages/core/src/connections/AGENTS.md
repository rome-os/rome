# packages/core/src/connections/

What Connections promises. Code inside and outside this folder keeps each promise. "Not yet true" means the code breaks it today and nothing checks it.

1. It offers only what [`index.ts`](index.ts) exports: connect, fix and disconnect with state changes, a message arrived, a command arrived and a way to answer it, send as the account, and each kind's tools. Not yet true.
2. Of `apps/`, it uses only the action contract, to offer each kind's tools. Not yet true.
3. Only the kind that made a message's `raw` reads its shape. A platform fact a kind exposes gets a named field. Not yet true.
4. It delivers a chat's messages in order and at least once, and a repeat has the same id. Partly checked: [`adapter-conformance.ts`](../test/kit/im/adapter-conformance.ts) checks order where a kind has groups and lookups.
5. It reports what the platform said and decides nothing from it, when an account connects as when a message arrives. The text is what the sender wrote, with nothing added. It reports every message the platform delivered and leaves none out. Not yet true for Feishu messages with only media and no text, and for Discord system notices. It names an account by the platform's id, and who the account belongs to is for Rome to work out. A message that is only mentions and a command, such as `/stop` or an account code, reports the bare command as its text, with the mentions kept in `mentions`: that is reporting, not deciding. Partly checked: [`reports-facts.test.ts`](reports-facts.test.ts) bans the addressing and bot fields. The rest is checked by review.

The words come from [`docs/domains/connections.md`](../../../../docs/domains/connections.md).

## Playbook

- When a change needs something from Connections that the five promises do not name, stop before writing it and ask the person. The answer is one of three: the promise grows, the use is removed, or the thing moves out of Connections.
