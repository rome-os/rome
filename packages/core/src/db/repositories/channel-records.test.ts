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

    expect(records.claim(db, { id: "c1", connectionKind: "feishu" }, NOW).id).toBe("feishu");
    const second = records.claim(db, { id: "c2", connectionKind: "feishu" }, NOW).id;
    const third = records.claim(db, { id: "c3", connectionKind: "feishu" }, NOW).id;
    expect(second).toMatch(UUID);
    expect(third).toMatch(UUID);
    expect(third).not.toBe(second);
    expect(records.claim(db, { id: "c4", connectionKind: "telegram_user" }, NOW)).toMatchObject({
      id: "telegram_user",
      platform: "telegram",
    });
  });

  it("puts a Feishu app on the platform its domain names", () => {
    const records = repository();
    const db = testDb!.db;

    const platformOf = (id: string, domain?: string) =>
      records.claim(db, { id, connectionKind: "feishu", domain }, NOW).platform;

    expect(platformOf("c1")).toBe("feishu");
    expect(platformOf("c2", "feishu")).toBe("feishu");
    expect(platformOf("c3", "lark")).toBe("lark");
  });

  it("keeps the channel a Connection already holds", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", connectionKind: "feishu" }, NOW);

    expect(records.claim(db, { id: "c1", connectionKind: "feishu" }, NOW).id).toBe("feishu");
    expect(records.all()).toHaveLength(1);
  });

  it("gives a re-added bot a fresh channel, with no agent", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", connectionKind: "feishu" }, NOW);
    records.link("feishu", "sales:agent");

    records.vacate(db, "c1");
    expect(records.byId("feishu")).toMatchObject({ connectionId: null, agent: null });

    const readded = records.claim(db, { id: "c2", connectionKind: "feishu" }, NOW);
    expect(readded.id).toMatch(UUID);
    expect(readded.agent).toBeNull();
    // The released channel keeps its id, so no later account is given it.
    expect(records.byId("feishu")).toMatchObject({ connectionId: null, agent: null });
  });

  it("starts every new account with no agent, and with the one asked only where it takes one", () => {
    const records = repository();
    const db = testDb!.db;

    expect(records.claim(db, { id: "c1", connectionKind: "telegram" }, NOW).agent).toBeNull();
    expect(records.claim(db, { id: "c2", connectionKind: "telegram_user" }, NOW).agent).toBeNull();
    expect(
      records.claim(db, { id: "c3", connectionKind: "feishu" }, NOW, { agent: "core:main" }).agent,
    ).toBe("core:main");
    expect(
      records.claim(db, { id: "c4", connectionKind: "webchat" }, NOW, { agent: "core:main" }).agent,
    ).toBeNull();
    expect(records.claim(db, { id: "c5", connectionKind: "agents" }, NOW).agent).toBeNull();
  });

  it("never gives a later account's channel to the next account", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", connectionKind: "feishu" }, NOW);
    const later = records.claim(db, { id: "c2", connectionKind: "feishu" }, NOW).id;
    records.link(later, "sales:agent");
    records.vacate(db, "c2");

    const next = records.claim(db, { id: "c3", connectionKind: "feishu" }, NOW);
    expect(next.id).not.toBe(later);
    expect(next.agent).toBeNull();
  });

  it("takes back a service's released channel when the service takes no agent", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", connectionKind: "email" }, NOW);
    const later = records.claim(db, { id: "c2", connectionKind: "email" }, NOW).id;
    records.vacate(db, "c2");
    records.vacate(db, "c1");

    expect(records.claim(db, { id: "c3", connectionKind: "email" }, NOW).id).toBe("email");
    expect(records.claim(db, { id: "c4", connectionKind: "email" }, NOW).id).toBe(later);
  });

  it("names the service behind a channel, and passes an unrecorded name through", () => {
    const records = repository();
    records.claim(testDb!.db, { id: "c1", connectionKind: "telegram" }, NOW);
    const second = records.claim(testDb!.db, { id: "c2", connectionKind: "telegram" }, NOW).id;

    expect(records.connectionKindOf(second)).toBe("telegram");
    expect(records.connectionKindOf("webchat")).toBe("webchat");
  });

  it("reaches a service's one account from a link, and none of several", () => {
    const db = repository() && testDb!.db;
    // Rows are written here around the repository, so each read is a fresh
    // repository's, with nothing cached from before the write.
    const records = {
      channelOfLink: (link: string) => new ChannelRecordsRepository(db).channelOfLink(link),
      vacate: (connectionId: string) => new ChannelRecordsRepository(db).vacate(db, connectionId),
    };
    // Nothing recorded: a link reaches the channel it names, as it always has.
    expect(records.channelOfLink("telegram")).toBe("telegram");
    expect(records.channelOfLink("whatsapp")).toBe("whatsapp");

    const opaque = (id: string, connectionId: string) =>
      db
        .insert(channels)
        .values({
          id,
          connectionKind: "telegram",
          platform: "telegram",
          connectionId,
          createdAt: NOW,
        })
        .run();

    // A first account connected with an opaque id.
    opaque("tg-opaque", "c1");
    expect(records.channelOfLink("telegram")).toBe("tg-opaque");
    expect(records.channelOfLink("tg-opaque")).toBe("tg-opaque");

    // A second account: Rome never picks between them.
    opaque("tg-second", "c2");
    expect(records.channelOfLink("telegram")).toBeNull();
    // A link naming one account's own id still reaches it.
    expect(records.channelOfLink("tg-second")).toBe("tg-second");

    // A removed account is not an account.
    records.vacate("c1");
    expect(records.channelOfLink("telegram")).toBe("tg-second");
  });

  it("answers a link again once an account connects, with no stale answer cached", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", connectionKind: "telegram" }, NOW);
    expect(records.channelOfLink("telegram")).toBe("telegram");
    expect(records.channelOfLink("telegram")).toBe("telegram");

    records.claim(db, { id: "c2", connectionKind: "telegram" }, NOW);
    expect(records.channelOfLink("telegram")).toBeNull();

    records.vacate(db, "c2");
    expect(records.channelOfLink("telegram")).toBe("telegram");
  });

  it("lists the accounts a send to a link may go out from", () => {
    const records = repository();
    const db = testDb!.db;
    // Nothing recorded: the link's own channel, as a send without `from` reaches.
    expect(records.sendersOfLink("whatsapp")).toEqual(["whatsapp"]);

    const first = records.claim(db, { id: "c1", connectionKind: "telegram" }, NOW).id;
    const later = new Date(NOW.getTime() + 60_000);
    const second = records.claim(db, { id: "c2", connectionKind: "telegram" }, later).id;
    expect(records.sendersOfLink("telegram")).toEqual([first, second]);
    // A link naming one account's own id lists that account alone.
    expect(records.sendersOfLink(second)).toEqual([second]);

    // A removed account sends nothing.
    records.vacate(db, "c2");
    expect(records.sendersOfLink("telegram")).toEqual([first]);
    expect(records.sendersOfLink(second)).toEqual([]);
  });

  it("reaches the service's own channel from a link while it is the only account", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", connectionKind: "telegram" }, NOW);
    expect(records.channelOfLink("telegram")).toBe("telegram");

    records.claim(db, { id: "c2", connectionKind: "telegram" }, NOW);
    expect(records.channelOfLink("telegram")).toBeNull();
  });

  it("keeps a Connection's channel name current across claims and releases", () => {
    const records = repository();
    const db = testDb!.db;
    expect(records.idOf("c1")).toBeNull();

    records.claim(db, { id: "c1", connectionKind: "feishu" }, NOW);
    expect(records.idOf("c1")).toBe("feishu");

    records.vacate(db, "c1");
    expect(records.idOf("c1")).toBeNull();
  });

  it("caches no name read inside a transaction that rolls back", () => {
    const records = repository();
    const db = testDb!.db;

    expect(() =>
      db.transaction((tx) => {
        records.claim(tx, { id: "c1", connectionKind: "feishu" }, NOW);
        expect(records.idOf("c1")).toBe("feishu");
        throw new Error("rollback");
      }),
    ).toThrow("rollback");

    expect(records.idOf("c1")).toBeNull();
  });

  it("links one agent to several channels of one platform and keeps each link", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", connectionKind: "telegram" }, NOW);
    records.claim(db, { id: "c2", connectionKind: "telegram_user" }, NOW);
    const later = records.claim(db, { id: "c3", connectionKind: "telegram" }, NOW).id;
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
    records.claim(db, { id: "c1", connectionKind: "feishu" }, NOW);
    const second = records.claim(db, { id: "c2", connectionKind: "feishu" }, NOW).id;
    records.link("feishu", "sales:agent");
    records.link(second, "sales:agent");

    records.link("feishu", null);

    expect(records.byId("feishu")?.agent).toBeNull();
    expect(records.byId(second)?.agent).toBe("sales:agent");
  });

  it("links main to several channels of one platform, by its canonical id", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", connectionKind: "telegram" }, NOW);
    const later = records.claim(db, { id: "c2", connectionKind: "telegram" }, NOW).id;
    records.link("telegram", "main");

    expect(records.link(later, "main")).toMatchObject({ agent: "core:main" });
    expect(records.byId("telegram")?.agent).toBe("core:main");
    expect(() =>
      db
        .update(channels)
        .set({ agent: "core:main" })
        .where(eq(channels.connectionKind, "telegram"))
        .run(),
    ).not.toThrow();
  });

  it("lets one agent hold a channel on each platform", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", connectionKind: "feishu" }, NOW);
    records.claim(db, { id: "c2", connectionKind: "telegram" }, NOW);
    records.link("feishu", "sales:agent");

    records.link("telegram", "sales:agent");

    expect(records.byId("telegram")?.agent).toBe("sales:agent");
    expect(records.byId("feishu")?.agent).toBe("sales:agent");
  });

  it("unlinks with null and keeps other links", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", connectionKind: "feishu" }, NOW);
    const second = records.claim(db, { id: "c2", connectionKind: "feishu" }, NOW).id;
    records.link("feishu", "sales:agent");
    records.link(second, "support:agent");

    records.link("feishu", null);

    expect(records.byId("feishu")?.agent).toBeNull();
    expect(records.byId(second)?.agent).toBe("support:agent");
  });

  it("refuses a link to a missing or unbacked channel", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", connectionKind: "feishu" }, NOW);
    records.vacate(db, "c1");

    expect(() => records.link("nope", "sales:agent")).toThrow(ChannelRecordNotFound);
    expect(() => records.link("feishu", "sales:agent")).toThrow(ChannelUnbacked);
  });

  it("refuses a link to a channel whose service takes none, and unlinks it", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", connectionKind: "agents" }, NOW);

    expect(() => records.link("agents", "sales:agent")).toThrow(ChannelNotLinkable);
    expect(records.link("agents", null).agent).toBeNull();
  });

  it("accepts a direct write that links one agent to every channel of a platform", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", connectionKind: "feishu" }, NOW);
    records.claim(db, { id: "c2", connectionKind: "feishu" }, NOW);

    expect(() => db.update(channels).set({ agent: "sales:agent" }).run()).not.toThrow();
    expect(records.all().map((record) => record.agent)).toEqual(["sales:agent", "sales:agent"]);
  });

  it("lists the Connections no channel records yet", () => {
    const records = repository();
    records.claim(testDb!.db, { id: "c1", connectionKind: "feishu" }, NOW);

    expect(
      records.unclaimed([
        { id: "c1", connectionKind: "feishu" },
        { id: "c2", connectionKind: "discord" },
      ]),
    ).toEqual([{ id: "c2", connectionKind: "discord" }]);
  });
});
