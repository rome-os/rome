import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { ChatAddresses } from "./chat-addresses.js";

const sales = { platform: "feishu", id: "bot-sales" };
const support = { platform: "feishu", id: "bot-support" };

describe("ChatAddresses", () => {
  let testDb: TestDb;
  let addresses: ChatAddresses;

  beforeEach(() => {
    testDb = createTestDb();
    addresses = new ChatAddresses(testDb.db);
  });
  afterEach(() => testDb.close());

  it("find a direct message's address by its key, and its key by the address", () => {
    addresses.bind(sales, "dm:bot-sales:ou_wei", "oc_p2p_1");

    expect(addresses.addressOf(sales, "dm:bot-sales:ou_wei")).toBe("oc_p2p_1");
    expect(addresses.keyAt(sales, "oc_p2p_1")).toBe("dm:bot-sales:ou_wei");
  });

  it("keep each account's address apart", () => {
    addresses.bind(sales, "dm:bot-sales:ou_wei", "oc_p2p_1");

    expect(addresses.addressOf(support, "dm:bot-sales:ou_wei")).toBeNull();
    expect(addresses.keyAt(support, "oc_p2p_1")).toBeNull();
  });

  it("keep the latest address an account heard a chat at", () => {
    addresses.bind(sales, "dm:bot-sales:ou_wei", "oc_p2p_1");
    addresses.bind(sales, "dm:bot-sales:ou_wei", "oc_p2p_2");

    expect(addresses.addressOf(sales, "dm:bot-sales:ou_wei")).toBe("oc_p2p_2");
  });

  it("find the chat a thread stands in by the thread's address, apart from chat addresses", () => {
    addresses.bindThread(sales, "omt_1", "oc_launch");

    expect(addresses.threadChatAt(sales, "omt_1")).toBe("oc_launch");
    expect(addresses.keyAt(sales, "omt_1")).toBeNull();
    expect(addresses.addressOf(sales, "oc_launch")).toBeNull();
  });

  it("move a chat Rome took for a direct message into the group another account already heard", () => {
    const discord = { platform: "discord", id: "bot-2" };
    const run = (query: ReturnType<typeof sql>) => testDb.db.run(query);
    // bot-1 heard group G; bot-2 had only sent there, so G was taken for a
    // direct message under bot-2's provisional key.
    run(sql`INSERT INTO chats (id, platform, key, kind, started_at) VALUES
      (1, 'discord', 'G', 'group', 1), (2, 'discord', 'dm:bot-2:G', 'dm', 1)`);
    run(sql`INSERT INTO chat_messages (id, chat_id, key, sender_account_id, sender_agent,
        text, parts, said_at) VALUES
      (10, 1, 'm1', 'ada', NULL, 'hi', '[]', 1),
      (11, 1, 'm2', 'bot-2', NULL, 'sent', '[]', 2),
      (20, 2, 'm2', 'bot-2', 'support', 'sent\n[image: Chart]', '[{"type":"text","content":"sent"}]', 2),
      (21, 2, 'm3', 'bot-2', 'support', 'later', '[]', 3)`);
    run(sql`UPDATE chat_messages SET reply_to_message_id = 20 WHERE id = 21`);
    run(sql`INSERT INTO rome_sessions (id, name, created_at, activity_at, chat_id, account_id)
      VALUES ('s1', 'G', 1, 1, 1, 'bot-1'), ('s2', 'G', 1, 1, 2, 'bot-2')`);
    run(sql`INSERT INTO agent_turn_messages (message_id, session_id, turn_id, role) VALUES
      (20, 's2', 't1', 'answer'), (21, 's2', 't2', 'answer')`);
    addresses.bind(discord, "dm:bot-2:G", "G");

    addresses.rekey(discord, "dm:bot-2:G", "G", "group");

    const all = <T>(query: ReturnType<typeof sql>) => testDb.db.all<T>(query);
    expect(all(sql`SELECT id, key FROM chats ORDER BY id`)).toEqual([{ id: 1, key: "G" }]);
    // bot-1 heard bot-2's send as anyone's message; the kept copy learns
    // which agent said it, and what it said as recorded.
    expect(
      all(sql`SELECT id, chat_id, reply_to_message_id AS reply, sender_agent AS agent, text
              FROM chat_messages ORDER BY id`),
    ).toEqual([
      { id: 10, chat_id: 1, reply: null, agent: null, text: "hi" },
      { id: 11, chat_id: 1, reply: null, agent: "support", text: "sent\n[image: Chart]" },
      { id: 21, chat_id: 1, reply: 11, agent: "support", text: "later" },
    ]);
    expect(all(sql`SELECT id, chat_id FROM rome_sessions ORDER BY id`)).toEqual([
      { id: "s1", chat_id: 1 },
      { id: "s2", chat_id: 1 },
    ]);
    expect(
      all(sql`SELECT message_id, turn_id FROM agent_turn_messages ORDER BY message_id`),
    ).toEqual([
      { message_id: 11, turn_id: "t1" },
      { message_id: 21, turn_id: "t2" },
    ]);
    expect(addresses.keyAt(discord, "G")).toBe("G");
  });
});
