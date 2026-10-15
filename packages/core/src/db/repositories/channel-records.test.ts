import { afterEach, describe, expect, it } from "@rstest/core";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import { ChannelRecordsRepository } from "./channel-records.js";

const NOW = new Date("2026-10-15T00:00:00.000Z");

describe("ChannelRecordsRepository", () => {
  let testDb: TestDb | undefined;
  afterEach(() => {
    testDb?.close();
    testDb = undefined;
  });

  function repository(): ChannelRecordsRepository {
    testDb = createTestDb();
    return new ChannelRecordsRepository(testDb.db);
  }

  it("names a service's first channel after it and later ones by number", () => {
    const records = repository();
    const db = testDb!.db;

    expect(records.claim(db, { id: "c1", service: "feishu" }, NOW).name).toBe("feishu");
    expect(records.claim(db, { id: "c2", service: "feishu" }, NOW).name).toBe("feishu-2");
    expect(records.claim(db, { id: "c3", service: "feishu" }, NOW).name).toBe("feishu-3");
    expect(records.claim(db, { id: "c4", service: "telegram_user" }, NOW)).toMatchObject({
      name: "telegram_user",
      platform: "telegram",
    });
  });

  it("keeps the channel a Connection already holds", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW);

    expect(records.claim(db, { id: "c1", service: "feishu" }, NOW).name).toBe("feishu");
    expect(records.all()).toHaveLength(1);
  });

  it("gives a released name back to the service's next Connection", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    records.claim(db, { id: "c2", service: "feishu" }, NOW);

    records.vacate(db, "c1");
    expect(records.byName("feishu")).toMatchObject({ connectionId: null });

    expect(records.claim(db, { id: "c3", service: "feishu" }, NOW).name).toBe("feishu");
    expect(records.byConnection("c3")?.name).toBe("feishu");
  });

  it("names the service behind a channel, and passes an unrecorded name through", () => {
    const records = repository();
    records.claim(testDb!.db, { id: "c1", service: "telegram" }, NOW);
    records.claim(testDb!.db, { id: "c2", service: "telegram" }, NOW);

    expect(records.serviceOf("telegram-2")).toBe("telegram");
    expect(records.serviceOf("webchat")).toBe("webchat");
  });

  it("lists the Connections no channel records yet", () => {
    const records = repository();
    records.claim(testDb!.db, { id: "c1", service: "feishu" }, NOW);

    expect(
      records.unclaimed([
        { id: "c1", service: "feishu" },
        { id: "c2", service: "discord" },
      ]),
    ).toEqual([{ id: "c2", service: "discord" }]);
  });
});
