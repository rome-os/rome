import { afterEach, describe, expect, it } from "@rstest/core";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import { ChannelRecordsRepository } from "./channel-records.js";

const NOW = new Date("2026-10-15T00:00:00.000Z");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

  it("names a service's first channel after it and later ones by an opaque id", () => {
    const records = repository();
    const db = testDb!.db;

    expect(records.claim(db, { id: "c1", service: "feishu" }, NOW).id).toBe("feishu");
    const second = records.claim(db, { id: "c2", service: "feishu" }, NOW).id;
    const third = records.claim(db, { id: "c3", service: "feishu" }, NOW).id;
    expect(second).toMatch(UUID);
    expect(third).toMatch(UUID);
    expect(third).not.toBe(second);
    expect(records.claim(db, { id: "c4", service: "telegram_user" }, NOW)).toMatchObject({
      id: "telegram_user",
      platform: "telegram",
    });
  });

  it("keeps the channel a Connection already holds", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW);

    expect(records.claim(db, { id: "c1", service: "feishu" }, NOW).id).toBe("feishu");
    expect(records.all()).toHaveLength(1);
  });

  it("gives a re-added bot the channel its deleted one held", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW);

    records.vacate(db, "c1");
    expect(records.byId("feishu")).toMatchObject({ connectionId: null });

    expect(records.claim(db, { id: "c2", service: "feishu" }, NOW).id).toBe("feishu");
    expect(records.all()).toHaveLength(1);
  });

  it("takes back the service-named channel before a later one", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    const later = records.claim(db, { id: "c2", service: "feishu" }, NOW).id;
    records.vacate(db, "c2");
    records.vacate(db, "c1");

    expect(records.claim(db, { id: "c3", service: "feishu" }, NOW).id).toBe("feishu");
    expect(records.claim(db, { id: "c4", service: "feishu" }, NOW).id).toBe(later);
  });

  it("names the service behind a channel, and passes an unrecorded name through", () => {
    const records = repository();
    records.claim(testDb!.db, { id: "c1", service: "telegram" }, NOW);
    const second = records.claim(testDb!.db, { id: "c2", service: "telegram" }, NOW).id;

    expect(records.serviceOf(second)).toBe("telegram");
    expect(records.serviceOf("webchat")).toBe("webchat");
  });

  it("keeps a Connection's channel name current across claims and releases", () => {
    const records = repository();
    const db = testDb!.db;
    expect(records.idOf("c1")).toBeNull();

    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    expect(records.idOf("c1")).toBe("feishu");

    records.vacate(db, "c1");
    expect(records.idOf("c1")).toBeNull();
  });

  it("caches no name read inside a transaction that rolls back", () => {
    const records = repository();
    const db = testDb!.db;

    expect(() =>
      db.transaction((tx) => {
        records.claim(tx, { id: "c1", service: "feishu" }, NOW);
        expect(records.idOf("c1")).toBe("feishu");
        throw new Error("rollback");
      }),
    ).toThrow("rollback");

    expect(records.idOf("c1")).toBeNull();
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
