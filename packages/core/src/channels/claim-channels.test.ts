import { afterEach, describe, expect, it } from "@rstest/core";
import { ChannelRecordsRepository } from "../db/repositories/channel-records.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { claimChannels, recordChannelAccounts } from "./claim-channels.js";

describe("claimChannels", () => {
  let testDb: TestDb | undefined;
  afterEach(() => {
    testDb?.close();
    testDb = undefined;
  });

  it("names each unrecorded Connection after its service and keeps recorded ones", () => {
    testDb = createTestDb();
    const records = new ChannelRecordsRepository(testDb.db);
    records.claim(testDb.db, { id: "c1", service: "feishu" }, new Date());

    claimChannels(testDb.db, records, [
      { id: "c1", service: "feishu" },
      { id: "c2", service: "telegram" },
      { id: "c3", service: "discord" },
    ]);

    expect(records.byConnection("c1")?.id).toBe("feishu");
    expect(records.byConnection("c2")?.id).toBe("telegram");
    expect(records.byConnection("c3")?.id).toBe("discord");
    expect(records.all()).toHaveLength(3);
  });

  it("records each backed channel's account from the identity its grants report", async () => {
    testDb = createTestDb();
    const records = new ChannelRecordsRepository(testDb.db);
    const connections = [
      { id: "c1", service: "telegram" },
      { id: "c2", service: "telegram" },
      { id: "c3", service: "email" },
    ];
    claimChannels(testDb.db, records, connections);
    const profiles: Record<string, Record<string, unknown> | undefined> = {
      c1: { botId: "bot-1" },
      c2: undefined,
      c3: { botId: "ignored" },
    };
    const registry = {
      getDescriptor: (service: string) =>
        service === "telegram"
          ? { accountIdOf: (_grant: string, profile: Record<string, unknown>) => profile.botId }
          : {},
      getLedger: () => ({
        listGrants: async (id: string) => [{ name: "bot", profile: profiles[id] }],
      }),
    } as unknown as Parameters<typeof recordChannelAccounts>[1];

    await recordChannelAccounts(records, registry, connections);

    expect(records.byConnection("c1")?.account).toBe("bot-1");
    expect(records.byConnection("c2")?.account).toBeNull();
    expect(records.byConnection("c3")?.account).toBeNull();
  });
});
