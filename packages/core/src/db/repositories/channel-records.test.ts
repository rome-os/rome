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

  it("gives a linkable service's account an opaque id, and the service's name only when asked", () => {
    const records = repository();
    const db = testDb!.db;

    expect(records.claim(db, { id: "c1", service: "feishu" }, NOW).id).toMatch(UUID);
    expect(records.claim(db, { id: "c2", service: "feishu" }, NOW, { id: "feishu" }).id).toBe(
      "feishu",
    );
    // A name already held is not taken twice.
    expect(records.claim(db, { id: "c3", service: "feishu" }, NOW, { id: "feishu" }).id).toMatch(
      UUID,
    );
    expect(
      records.claim(db, { id: "c4", service: "telegram_user" }, NOW, { id: "telegram_user" }),
    ).toMatchObject({ id: "telegram_user", platform: "telegram" });
  });

  it("names a service that takes no agent after itself, and later channels by an opaque id", () => {
    const records = repository();
    const db = testDb!.db;

    expect(records.claim(db, { id: "c1", service: "email" }, NOW).id).toBe("email");
    expect(records.claim(db, { id: "c2", service: "email" }, NOW).id).toMatch(UUID);
  });

  it("puts a Feishu app on the platform its domain names", () => {
    const records = repository();
    const db = testDb!.db;

    const platformOf = (id: string, domain?: string) =>
      records.claim(db, { id, service: "feishu", domain }, NOW).platform;

    expect(platformOf("c1")).toBe("feishu");
    expect(platformOf("c2", "feishu")).toBe("feishu");
    expect(platformOf("c3", "lark")).toBe("lark");
  });

  it("keeps the channel a Connection already holds", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW, { id: "feishu" });

    expect(records.claim(db, { id: "c1", service: "feishu" }, NOW).id).toBe("feishu");
    expect(records.all()).toHaveLength(1);
  });

  it("gives a re-added bot a fresh channel, with no agent", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW, { id: "feishu" });
    records.link("feishu", "sales:agent");

    records.vacate(db, "c1");
    expect(records.byId("feishu")).toMatchObject({ connectionId: null, agent: null });

    const readded = records.claim(db, { id: "c2", service: "feishu" }, NOW);
    expect(readded.id).toMatch(UUID);
    expect(readded.agent).toBeNull();
    // The released channel keeps its id, so no later account is given it.
    expect(records.byId("feishu")).toMatchObject({ connectionId: null, agent: null });
  });

  it("starts every new account with no agent, and with the one asked only where it takes one", () => {
    const records = repository();
    const db = testDb!.db;

    expect(
      records.claim(db, { id: "c1", service: "telegram" }, NOW, { id: "telegram" }).agent,
    ).toBeNull();
    expect(
      records.claim(db, { id: "c2", service: "telegram_user" }, NOW, { id: "telegram_user" }).agent,
    ).toBeNull();
    expect(
      records.claim(db, { id: "c3", service: "feishu" }, NOW, { id: "feishu", agent: "core:main" })
        .agent,
    ).toBe("core:main");
    expect(
      records.claim(db, { id: "c4", service: "webchat" }, NOW, { agent: "core:main" }).agent,
    ).toBeNull();
    expect(records.claim(db, { id: "c5", service: "agents" }, NOW).agent).toBeNull();
  });

  it("never gives a later account's channel to the next account", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW, { id: "feishu" });
    const later = records.claim(db, { id: "c2", service: "feishu" }, NOW).id;
    records.link(later, "sales:agent");
    records.vacate(db, "c2");

    const next = records.claim(db, { id: "c3", service: "feishu" }, NOW);
    expect(next.id).not.toBe(later);
    expect(next.agent).toBeNull();
  });

  it("takes back a service's released channel when the service takes no agent", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "email" }, NOW);
    const later = records.claim(db, { id: "c2", service: "email" }, NOW).id;
    records.vacate(db, "c2");
    records.vacate(db, "c1");

    expect(records.claim(db, { id: "c3", service: "email" }, NOW).id).toBe("email");
    expect(records.claim(db, { id: "c4", service: "email" }, NOW).id).toBe(later);
  });

  it("names the service behind a channel, and passes an unrecorded name through", () => {
    const records = repository();
    records.claim(testDb!.db, { id: "c1", service: "telegram" }, NOW, { id: "telegram" });
    const second = records.claim(testDb!.db, { id: "c2", service: "telegram" }, NOW).id;

    expect(records.serviceOf(second)).toBe("telegram");
    expect(records.serviceOf("webchat")).toBe("webchat");
  });

  it("keeps a Connection's channel name current across claims and releases", () => {
    const records = repository();
    const db = testDb!.db;
    expect(records.idOf("c1")).toBeNull();

    records.claim(db, { id: "c1", service: "feishu" }, NOW, { id: "feishu" });
    expect(records.idOf("c1")).toBe("feishu");

    records.vacate(db, "c1");
    expect(records.idOf("c1")).toBeNull();
  });

  it("caches no name read inside a transaction that rolls back", () => {
    const records = repository();
    const db = testDb!.db;

    expect(() =>
      db.transaction((tx) => {
        records.claim(tx, { id: "c1", service: "feishu" }, NOW, { id: "feishu" });
        expect(records.idOf("c1")).toBe("feishu");
        throw new Error("rollback");
      }),
    ).toThrow("rollback");

    expect(records.idOf("c1")).toBeNull();
  });

  it("links one agent to several channels of one platform and keeps each link", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "telegram" }, NOW, { id: "telegram" });
    records.claim(db, { id: "c2", service: "telegram_user" }, NOW, { id: "telegram_user" });
    const later = records.claim(db, { id: "c3", service: "telegram" }, NOW).id;
    records.link("telegram", "sales:agent");

    expect(records.link("telegram_user", "sales:agent")).toMatchObject({
      id: "telegram_user",
      agent: "sales:agent",
    });
    records.link(later, "sales:agent");

    expect(records.byId("telegram")?.agent).toBe("sales:agent");
    expect(records.byId("telegram_user")?.agent).toBe("sales:agent");
    expect(records.byId(later)?.agent).toBe("sales:agent");
  });

  it("unlinks one channel of an agent and leaves its other channels linked", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW, { id: "feishu" });
    const second = records.claim(db, { id: "c2", service: "feishu" }, NOW).id;
    records.link("feishu", "sales:agent");
    records.link(second, "sales:agent");

    records.link("feishu", null);

    expect(records.byId("feishu")?.agent).toBeNull();
    expect(records.byId(second)?.agent).toBe("sales:agent");
  });

  it("links main to several channels of one platform, by its canonical id", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "telegram" }, NOW, { id: "telegram" });
    const later = records.claim(db, { id: "c2", service: "telegram" }, NOW).id;
    records.link("telegram", "main");

    expect(records.link(later, "main")).toMatchObject({ agent: "core:main" });
    expect(records.byId("telegram")?.agent).toBe("core:main");
    expect(() =>
      db.update(channels).set({ agent: "core:main" }).where(eq(channels.service, "telegram")).run(),
    ).not.toThrow();
  });

  it("lets one agent hold a channel on each platform", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW, { id: "feishu" });
    records.claim(db, { id: "c2", service: "telegram" }, NOW, { id: "telegram" });
    records.link("feishu", "sales:agent");

    records.link("telegram", "sales:agent");

    expect(records.byId("telegram")?.agent).toBe("sales:agent");
    expect(records.byId("feishu")?.agent).toBe("sales:agent");
  });

  it("unlinks with null and keeps other links", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW, { id: "feishu" });
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
    records.claim(db, { id: "c1", service: "feishu" }, NOW, { id: "feishu" });
    records.vacate(db, "c1");

    expect(() => records.link("nope", "sales:agent")).toThrow(ChannelRecordNotFound);
    expect(() => records.link("feishu", "sales:agent")).toThrow(ChannelUnbacked);
  });

  it("refuses a link to a channel whose service takes none, and unlinks it", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "agents" }, NOW);

    expect(() => records.link("agents", "sales:agent")).toThrow(ChannelNotLinkable);
    expect(records.link("agents", null).agent).toBeNull();
  });

  it("accepts a direct write that links one agent to every channel of a platform", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW, { id: "feishu" });
    records.claim(db, { id: "c2", service: "feishu" }, NOW);

    expect(() => db.update(channels).set({ agent: "sales:agent" }).run()).not.toThrow();
    expect(records.all().map((record) => record.agent)).toEqual(["sales:agent", "sales:agent"]);
  });

  it("lists the Connections no channel records yet", () => {
    const records = repository();
    records.claim(testDb!.db, { id: "c1", service: "feishu" }, NOW, { id: "feishu" });

    expect(
      records.unclaimed([
        { id: "c1", service: "feishu" },
        { id: "c2", service: "discord" },
      ]),
    ).toEqual([{ id: "c2", service: "discord" }]);
  });
});
