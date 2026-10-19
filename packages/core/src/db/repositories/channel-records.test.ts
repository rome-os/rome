import { afterEach, describe, expect, it } from "@rstest/core";
import { eq } from "drizzle-orm";
import { channels } from "../schema.js";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import {
  ChannelNotLinkable,
  ChannelRecordNotFound,
  ChannelRecordsRepository,
  ChannelUnbacked,
} from "./channel-records.js";

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

  it("gives a re-added bot the channel its deleted one held, linked to main again", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    records.link("feishu", "sales:agent");

    records.vacate(db, "c1");
    expect(records.byId("feishu")).toMatchObject({ connectionId: null, agent: null });

    expect(records.claim(db, { id: "c2", service: "feishu" }, NOW)).toMatchObject({
      id: "feishu",
      agent: "core:main",
    });
    expect(records.all()).toHaveLength(1);
  });

  it("links main to a linkable service's first account only", () => {
    const records = repository();
    const db = testDb!.db;

    expect(records.claim(db, { id: "c1", service: "telegram" }, NOW).agent).toBe("core:main");
    expect(records.claim(db, { id: "c2", service: "telegram_user" }, NOW).agent).toBe("core:main");
    expect(records.claim(db, { id: "c3", service: "telegram" }, NOW).agent).toBeNull();
    expect(records.claim(db, { id: "c4", service: "webchat" }, NOW).agent).toBeNull();
    expect(records.claim(db, { id: "c5", service: "agents" }, NOW).agent).toBeNull();
  });

  it("takes back a later account unlinked", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    const later = records.claim(db, { id: "c2", service: "feishu" }, NOW).id;
    records.link(later, "sales:agent");
    records.vacate(db, "c2");

    expect(records.claim(db, { id: "c3", service: "feishu" }, NOW)).toMatchObject({
      id: later,
      agent: null,
    });
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

  it("moves an agent between channels of one platform", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "telegram" }, NOW);
    records.claim(db, { id: "c2", service: "telegram_user" }, NOW);
    records.link("telegram", "sales:agent");

    const outcome = records.link("telegram_user", "sales:agent");

    expect(outcome).toMatchObject({
      channel: { id: "telegram_user", agent: "sales:agent" },
      unlinkedFrom: "telegram",
    });
    expect(records.byId("telegram")?.agent).toBeNull();
  });

  it("links main to several channels of one platform, by its canonical id", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "telegram" }, NOW);
    const later = records.claim(db, { id: "c2", service: "telegram" }, NOW).id;

    const outcome = records.link(later, "main");

    expect(outcome).toMatchObject({ channel: { agent: "core:main" }, unlinkedFrom: null });
    expect(records.byId("telegram")?.agent).toBe("core:main");
    expect(() =>
      db.update(channels).set({ agent: "core:main" }).where(eq(channels.service, "telegram")).run(),
    ).not.toThrow();
  });

  it("lets one agent hold a channel on each platform", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    records.claim(db, { id: "c2", service: "telegram" }, NOW);
    records.link("feishu", "sales:agent");

    expect(records.link("telegram", "sales:agent").unlinkedFrom).toBeNull();
    expect(records.byId("feishu")?.agent).toBe("sales:agent");
  });

  it("unlinks with null and keeps other links", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    const second = records.claim(db, { id: "c2", service: "feishu" }, NOW).id;
    records.link("feishu", "sales:agent");
    records.link(second, "support:agent");

    records.link("feishu", null);

    expect(records.byId("feishu")?.agent).toBeNull();
    expect(records.byId(second)?.agent).toBe("support:agent");
  });

  it("refuses a link to a missing or unbacked channel", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    records.vacate(db, "c1");

    expect(() => records.link("nope", "sales:agent")).toThrow(ChannelRecordNotFound);
    expect(() => records.link("feishu", "sales:agent")).toThrow(ChannelUnbacked);
  });

  it("refuses a link to a channel whose service takes none, and unlinks it", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "agents" }, NOW);

    expect(() => records.link("agents", "sales:agent")).toThrow(ChannelNotLinkable);
    expect(records.link("agents", null).channel.agent).toBeNull();
  });

  it("rejects a direct write that links one agent twice on a platform", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    records.claim(db, { id: "c2", service: "feishu" }, NOW);
    records.link("feishu", "sales:agent");

    expect(() => db.update(channels).set({ agent: "sales:agent" }).run()).toThrow(
      /UNIQUE constraint failed/,
    );
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
