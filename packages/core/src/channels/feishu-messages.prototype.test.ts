// PROTOTYPE — throwaway. Enrolls the direct-from-Feishu store in the real
// contract suite, the way messages-memory.test.ts enrolls the reference store,
// and measures what the directory pattern costs in API calls.

import { describe, expect, it } from "@rstest/core";
import { testMessagesContract, WHOLE_HISTORY } from "./messages-contract.js";
import type { MessageAccount } from "./messages.js";
import {
  fakeFeishu,
  feishuMessages,
  msg,
  type FeishuMessageItem,
} from "./feishu-messages.prototype.js";

// Two p2p chats and one group, seeded the way messages-memory.test.ts seeds the
// reference store: at least four messages, two of them in the same second, and
// a group nothing in it is addressed by.
//
// The tied second sits at the top of the history on purpose. That is not a
// trick — the contract *requires* enrolling a same-second pair, and Rome's
// order deliberately puts an outbound reply above the inbound line it answers
// (`compareTimelineEntries`, packages/api-types/src/people.ts:232-238), while
// Feishu ranks by `create_time` and puts the reply after. A bot answering
// inside one second is the ordinary case, not the rare one.
const ADA_CHAT = "oc_ada";
const BO_CHAT = "oc_bo";
const TEAM_CHAT = "oc_team";
const DENSE_CHAT = "oc_dense";

const chats: Record<string, FeishuMessageItem[]> = {
  [ADA_CHAT]: [
    msg(ADA_CHAT, "a1", 100_000, "user"),
    msg(ADA_CHAT, "a2", 200_000, "user"),
    // Rome ranks a3 above a4 (same second, outbound first). Feishu ranks a4
    // above a3 (later millisecond).
    msg(ADA_CHAT, "a3", 300_000, "app"),
    msg(ADA_CHAT, "a4", 300_500, "user"),
  ],
  [BO_CHAT]: [msg(BO_CHAT, "b1", 50_000, "user"), msg(BO_CHAT, "b2", 250_000, "app")],
  [TEAM_CHAT]: [
    msg(TEAM_CHAT, "g1", 800_000, "user"),
    msg(TEAM_CHAT, "g2", 900_000, "user"),
    msg(TEAM_CHAT, "g3", 900_400, "app"),
    msg(TEAM_CHAT, "g4", 1_000_000, "user"),
  ],
  // A second that spans a page boundary at page_size 2.
  [DENSE_CHAT]: [
    msg(DENSE_CHAT, "d1", 10_000, "user"),
    msg(DENSE_CHAT, "d2", 20_000, "app"),
    msg(DENSE_CHAT, "d3", 20_900, "user"),
    msg(DENSE_CHAT, "d4", 20_950, "user"),
    msg(DENSE_CHAT, "d5", 30_000, "user"),
  ],
};

// The map the research note says is the only way a p2p chat is ever named: a
// chat id learned from an inbound message. `ou_stranger` is a person on the
// channel whose chat has never been learned.
const learned: Record<string, string> = { ou_ada: ADA_CHAT, ou_bo: BO_CHAT };
const chatIdOf = (address: string) => learned[address];

const accounts: MessageAccount[] = [
  { channel: "feishu", addresses: ["ou_ada"] },
  { channel: "feishu", addresses: ["ou_bo"] },
];

const subject = (latest: "one-call" | "whole-second") => () => ({
  messages: feishuMessages(fakeFeishu(chats).client, chatIdOf, { latest }),
  accounts,
  silent: [{ channel: "feishu", addresses: ["ou_stranger"] }],
  conversation: { channel: "feishu", id: TEAM_CHAT },
  silentConversation: { channel: "feishu", id: "oc_quiet" },
});

// The note's claim, enrolled verbatim: "`latest` is one call with `page_size: 1`
// descending".
testMessagesContract("feishuMessages, latest as the note claims", subject("one-call"));

// The same store with `latest` reconciled against Rome's ordering instead.
testMessagesContract("feishuMessages, latest reconciled", subject("whole-second"));

describe("feishuMessages prototype", () => {
  it("shows why the one-call latest disagrees with the full read", async () => {
    const { client } = fakeFeishu(chats);
    const store = feishuMessages(client, chatIdOf, { latest: "one-call" });

    const full = await store.read({ accounts, limit: WHOLE_HISTORY });
    expect(full.map((e) => e.ref)).toEqual(["a3", "a4", "b2", "a2", "a1", "b1"]);

    // The platform's newest message by create_time is a4. Rome's newest entry
    // is a3, the outbound reply in the same second.
    expect((await store.latest(accounts))?.ref).toBe("a4");
    expect(full[0]?.ref).toBe("a3");
  });

  it("answers the same latest as the full read once it reads the whole second", async () => {
    const { client, log } = fakeFeishu(chats);
    const store = feishuMessages(client, chatIdOf, { latest: "whole-second" });
    expect((await store.latest(accounts))?.ref).toBe("a3");
    // Two chats, one page each — the cost is the page, not the call.
    expect(log.calls.length).toBe(2);
  });

  it("keeps a page correct across a boundary inside one second", async () => {
    const { client, log } = fakeFeishu(chats);
    const store = feishuMessages(client, chatIdOf, { pageSize: 2 });
    const conversation = { channel: "feishu", id: DENSE_CHAT };

    const page = await store.readConversation({ conversation, limit: 2 });
    // d2 is the outbound in the same second as d3 and d4, and the platform
    // returns it on the second page. A store that answered the first API page
    // would have said [d5, d4].
    expect(page.map((e) => e.ref)).toEqual(["d5", "d2"]);
    // The cost of being right: the whole chat was walked to answer two entries.
    expect(log.calls.length).toBe(3);
  });

  it("pages a dense conversation to exhaustion over exactly its full read", async () => {
    const { client } = fakeFeishu(chats);
    const store = feishuMessages(client, chatIdOf, { pageSize: 2 });
    const conversation = { channel: "feishu", id: DENSE_CHAT };
    const full = await store.readConversation({ conversation, limit: WHOLE_HISTORY });
    expect(full.map((e) => e.ref)).toEqual(["d5", "d2", "d3", "d4", "d1"]);

    const walked: string[] = [];
    let after = null as (typeof full)[number] | null;
    for (let page = 0; page < 10; page++) {
      const entries = await store.readConversation({ conversation, after, limit: 2 });
      if (entries.length === 0) break;
      walked.push(...entries.map((e) => e.ref));
      after = entries[entries.length - 1] ?? null;
    }
    expect(walked).toEqual(full.map((e) => e.ref));
  });

  it("reports an account whose chat id was never learned as one with no history", async () => {
    const { client, log } = fakeFeishu(chats);
    const store = feishuMessages(client, chatIdOf, { latest: "whole-second" });
    const stranger = [{ channel: "feishu", addresses: ["ou_stranger"] }];

    expect(await store.latest(stranger)).toBeNull();
    expect(await store.count(stranger)).toBe(0);
    expect(await store.read({ accounts: stranger, limit: WHOLE_HISTORY })).toEqual([]);
    // Not one call was made, because there was no chat to name. The answer is
    // the same one a genuinely silent account gets, and the store cannot tell
    // the two apart — `latest` returning null is the only signal the contract
    // gives, and `assignAccountHeads` (../people/timeline.ts:113-121) reads it
    // as "this store does not hold this account".
    expect(log.calls.length).toBe(0);
  });

  it("reports a chat the bot may not read as one with no messages", async () => {
    const { client } = fakeFeishu(chats);
    const store = feishuMessages(client, chatIdOf);
    // The fake answers 230002 for any chat it does not hold, which is what the
    // platform answers for a group the bot is not in.
    expect(
      await store.readConversation({
        conversation: { channel: "feishu", id: "oc_forbidden" },
        limit: WHOLE_HISTORY,
      }),
    ).toEqual([]);
  });
});

// The directory pattern: `readPeopleActivity` (../people/activity.ts:62-65)
// raises one `count` and one `latest` per person per store in one pass, and
// `readAccountStream` (../people/account-directory.ts:130) raises `latest` over
// a thousand addresses a round.
describe("feishuMessages prototype: directory cost", () => {
  const DIRECTORY = 50;
  const HISTORY = 250;

  const directory = (): {
    chats: Record<string, FeishuMessageItem[]>;
    map: Record<string, string>;
    accounts: MessageAccount[];
  } => {
    const built: Record<string, FeishuMessageItem[]> = {};
    const map: Record<string, string> = {};
    const list: MessageAccount[] = [];
    for (let person = 0; person < DIRECTORY; person++) {
      const chatId = `oc_p${person}`;
      const address = `ou_p${person}`;
      map[address] = chatId;
      list.push({ channel: "feishu", addresses: [address] });
      built[chatId] = Array.from({ length: HISTORY }, (_, i) =>
        msg(chatId, `p${person}:m${i}`, (i + 1) * 1000, i % 3 === 0 ? "app" : "user"),
      );
    }
    return { chats: built, map, accounts: list };
  };

  it("costs one call per account for latest, and the page it does not use", async () => {
    const { chats: built, map, accounts: list } = directory();

    const { client: cheapClient, log: cheap } = fakeFeishu(built);
    const cheapStore = feishuMessages(cheapClient, (a) => map[a], { latest: "one-call" });
    for (const account of list) await cheapStore.latest([account]);

    const { client: rightClient, log: right } = fakeFeishu(built);
    const rightStore = feishuMessages(rightClient, (a) => map[a], { latest: "whole-second" });
    for (const account of list) await rightStore.latest([account]);

    expect(cheap.calls.length).toBe(DIRECTORY);
    expect(cheap.items).toBe(DIRECTORY);
    // Reconciling costs the same calls but a full page each, and it is still
    // one round trip per row where sqlMessages folds the whole directory into
    // one statement.
    expect(right.calls.length).toBe(DIRECTORY);
    expect(right.items).toBe(DIRECTORY * 50);
  });

  it("costs a full walk of every chat for count", async () => {
    const { chats: built, map, accounts: list } = directory();
    const { client, log } = fakeFeishu(built);
    const store = feishuMessages(client, (a) => map[a]);

    for (const account of list) expect(await store.count([account])).toBe(HISTORY);

    // 250 messages at the API's 50-per-page ceiling is 5 calls a person.
    expect(log.calls.length).toBe(DIRECTORY * Math.ceil(HISTORY / 50));
    expect(log.items).toBe(DIRECTORY * HISTORY);
  });

  it("costs 300 calls and 12,500 messages for one readPeopleActivity pass", async () => {
    const { chats: built, map, accounts: list } = directory();
    const { client, log } = fakeFeishu(built);
    const store = feishuMessages(client, (a) => map[a], { latest: "one-call" });

    // What activity.ts raises for one directory page: a count and a latest per
    // person, all in one tick.
    await Promise.all(list.flatMap((a) => [store.count([a]), store.latest([a])]));

    expect(log.calls.length).toBe(300);
    expect(log.items).toBe(12_550);
    // The platform's ceiling is 50 requests a second, so this pass cannot
    // finish in under six seconds however it is scheduled.
    expect(log.calls.length / 50).toBeGreaterThan(5);
  });
});
