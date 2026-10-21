import { afterEach, describe, expect, it } from "@rstest/core";
import { ChannelRecordsRepository } from "../db/repositories/channel-records.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { claimChannels } from "./claim-channels.js";

describe("claimChannels", () => {
  let testDb: TestDb | undefined;
  afterEach(() => {
    testDb?.close();
    testDb = undefined;
  });

  it("names each unrecorded Connection after its service and keeps recorded ones", async () => {
    testDb = createTestDb();
    const records = new ChannelRecordsRepository(testDb.db);
    records.claim(testDb.db, { id: "c1", service: "feishu" }, new Date());

    await claimChannels(testDb.db, records, [
      { id: "c1", service: "feishu" },
      { id: "c2", service: "telegram" },
      { id: "c3", service: "discord" },
    ]);

    expect(records.byConnection("c1")?.id).toBe("feishu");
    expect(records.byConnection("c2")?.id).toBe("telegram");
    expect(records.byConnection("c3")?.id).toBe("discord");
    expect(records.all()).toHaveLength(3);
  });

  it("asks only unrecorded Connections their domain, and puts a Lark app on Lark", async () => {
    testDb = createTestDb();
    const records = new ChannelRecordsRepository(testDb.db);
    records.claim(testDb.db, { id: "c1", service: "telegram" }, new Date());
    const asked: string[] = [];

    await claimChannels(
      testDb.db,
      records,
      [
        { id: "c1", service: "telegram" },
        { id: "c2", service: "feishu" },
      ],
      async (id) => {
        asked.push(id);
        return "lark";
      },
    );

    expect(asked).toEqual(["c2"]);
    expect(records.byConnection("c2")?.platform).toBe("lark");
  });
});
