import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
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
});
