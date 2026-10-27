import { afterEach, describe, expect, it } from "@rstest/core";
import { channels } from "../schema.js";
import { createTestDb, type TestDb, testAccountLinkOf } from "../../test/helpers.js";
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
    return new ChannelRecordsRepository(testDb.db, testAccountLinkOf);
  }

  it("gives a linkable service's account an opaque id, and the service's name only when asked", () => {
    const records = repository();
    const db = testDb!.db;

    expect(records.claim(db, { id: "c1", connectionKind: "feishu" }, NOW).id).toMatch(UUID);
    expect(
      records.claim(db, { id: "c2", connectionKind: "feishu" }, NOW, { id: "feishu" }).id,
    ).toBe("feishu");
    // A name already held is not taken twice.
    expect(
      records.claim(db, { id: "c3", connectionKind: "feishu" }, NOW, { id: "feishu" }).id,
    ).toMatch(UUID);
    expect(
      records.claim(db, { id: "c4", connectionKind: "telegram_user" }, NOW, {
        id: "telegram_user",
      }),
    ).toMatchObject({ id: "telegram_user", platform: "telegram" });
  });

  it("names a connection kind that takes no agent after itself, and later channels by an opaque id", () => {
    const records = repository();
    const db = testDb!.db;

    expect(records.claim(db, { id: "c1", connectionKind: "email" }, NOW).id).toBe("email");
    expect(records.claim(db, { id: "c2", connectionKind: "email" }, NOW).id).toMatch(UUID);
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
    records.claim(db, { id: "c1", connectionKind: "feishu" }, NOW, { id: "feishu" });

    expect(records.claim(db, { id: "c1", connectionKind: "feishu" }, NOW).id).toBe("feishu");
    expect(records.all()).toHaveLength(1);
  });

  it("gives a re-added bot a fresh channel", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", connectionKind: "feishu" }, NOW, { id: "feishu" });

    records.vacate(db, "c1");
    expect(records.byId("feishu")).toMatchObject({ connectionId: null });

    const readded = records.claim(db, { id: "c2", connectionKind: "feishu" }, NOW);
    expect(readded.id).toMatch(UUID);
    // The released channel keeps its id, so no later account is given it.
    expect(records.byId("feishu")).toMatchObject({ connectionId: null });
  });

  it("never gives a later account's channel to the next account", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", connectionKind: "feishu" }, NOW, { id: "feishu" });
    const later = records.claim(db, { id: "c2", connectionKind: "feishu" }, NOW).id;
    records.vacate(db, "c2");

    const next = records.claim(db, { id: "c3", connectionKind: "feishu" }, NOW);
    expect(next.id).not.toBe(later);
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

  it("records the account a channel is, by the platform's own id", () => {
    const records = repository();
    const db = testDb!.db;

    expect(
      records.claim(
        db,
        {
          id: "c1",
          connectionKind: "email",
          account: { platform: "email", accountId: "a@x.test" },
        },
        NOW,
      ),
    ).toMatchObject({ platform: "email", platformAccountId: "a@x.test" });
    expect(records.claim(db, { id: "c2", connectionKind: "telegram" }, NOW).platformAccountId).toBe(
      null,
    );
  });

  it("takes back a released channel for the next account, which replaces the account it held", () => {
    const records = repository();
    const db = testDb!.db;
    const a = records.claim(
      db,
      { id: "c1", connectionKind: "email", account: { platform: "email", accountId: "a@x.test" } },
      NOW,
    );
    records.vacate(db, "c1");
    expect(records.byId(a.id)?.platformAccountId).toBe("a@x.test");

    // Names such as `email` still reach a connection kind's one channel, so
    // the next account takes it back, as before channels knew their account.
    const b = records.claim(
      db,
      { id: "c2", connectionKind: "email", account: { platform: "email", accountId: "b@x.test" } },
      NOW,
    );
    expect(b).toMatchObject({ id: a.id, platformAccountId: "b@x.test" });
  });

  it("gives a reconnected account that takes an agent a fresh record", () => {
    const records = repository();
    const db = testDb!.db;
    const first = records.claim(
      db,
      {
        id: "c1",
        connectionKind: "telegram",
        account: { platform: "telegram", accountId: "bot-1" },
      },
      NOW,
    );
    records.vacate(db, "c1");
    expect(records.byId(first.id)?.platformAccountId).toBeNull();

    const again = records.claim(
      db,
      {
        id: "c2",
        connectionKind: "telegram",
        account: { platform: "telegram", accountId: "bot-1" },
      },
      NOW,
    );
    expect(again.id).not.toBe(first.id);
    expect(again.platformAccountId).toBe("bot-1");
  });

  it("records an account a later grant reports, and the next account a kept Connection reaches", () => {
    const records = repository();
    const db = testDb!.db;
    const record = records.claim(db, { id: "c1", connectionKind: "whatsapp" }, NOW);

    records.recordAccount(db, "c1", { platform: "whatsapp", accountId: "a" });
    expect(records.byId(record.id)?.platformAccountId).toBe("a");
    // The grant was revoked and given again for account b, on the same Connection.
    records.recordAccount(db, "c1", { platform: "whatsapp", accountId: "b" });
    expect(records.byId(record.id)?.platformAccountId).toBe("b");
    // No channel backed by the Connection: nothing to record.
    records.recordAccount(db, "missing", { platform: "whatsapp", accountId: "c" });
    expect(records.all()).toHaveLength(1);
  });

  it("takes an account from a record whose Connection no longer reaches it", () => {
    const records = repository();
    const db = testDb!.db;
    const account = { platform: "telegram", accountId: "42" };
    // A Connection kept after its grant was revoked still backs its record.
    const old = records.claim(db, { id: "c1", connectionKind: "telegram_user", account }, NOW);

    const next = records.claim(db, { id: "c2", connectionKind: "telegram_user", account }, NOW);
    expect(next.platformAccountId).toBe("42");
    // The old record lets go of the Connection with the account, so it does
    // not fall back to it as a record that never knew its account.
    expect(records.byId(old.id)).toMatchObject({ connectionId: null, platformAccountId: null });
    expect(records.idOf("c1")).toBeNull();
  });

  it("moves a record to the platform its account is on", () => {
    const records = repository();
    const db = testDb!.db;
    // A Feishu app claimed before its profile named a domain.
    const record = records.claim(db, { id: "c1", connectionKind: "feishu" }, NOW);
    expect(record.platform).toBe("feishu");

    records.recordAccount(db, "c1", { platform: "lark", accountId: "app-1" });
    expect(records.byId(record.id)).toMatchObject({ platform: "lark", platformAccountId: "app-1" });
  });

  it("names the service behind a channel, and passes an unrecorded name through", () => {
    const records = repository();
    records.claim(testDb!.db, { id: "c1", connectionKind: "telegram" }, NOW, { id: "telegram" });
    const second = records.claim(testDb!.db, { id: "c2", connectionKind: "telegram" }, NOW).id;

    expect(records.connectionKindOf(second)).toBe("telegram");
    expect(records.connectionKindOf("webchat")).toBe("webchat");
  });

  it("reads a channel's platform from its record, and a name with none as its kind's", () => {
    const records = repository();
    const db = testDb!.db;
    // A Lark app on the Feishu kind takes the kind's name for its channel.
    records.claim(db, { id: "c1", connectionKind: "feishu", domain: "lark" }, NOW, {
      id: "feishu",
    });
    const second = records.claim(db, { id: "c2", connectionKind: "telegram" }, NOW).id;

    expect(records.platformOfChannel("feishu")).toBe("lark");
    expect(records.platformOfChannel(second)).toBe("telegram");
    expect(records.platformOfChannel("telegram_user")).toBe("telegram");
    expect(records.platformOfChannel("webchat")).toBe("webchat");
  });

  it("lists the accounts on a platform a send may go out from, oldest first", () => {
    const records = repository();
    const db = testDb!.db;
    // Nothing recorded on the platform: the channels named after it answer.
    expect(records.sendersOn("whatsapp")).toBeNull();

    const bot = records.claim(db, { id: "c1", connectionKind: "telegram" }, NOW).id;
    const later = new Date(NOW.getTime() + 60_000);
    const own = records.claim(db, { id: "c2", connectionKind: "telegram_user" }, later).id;
    // A bot and a signed-in account are two of Rome's accounts on one platform.
    expect(records.sendersOn("telegram")).toEqual([bot, own]);

    // A removed account sends nothing, and a platform whose every account is
    // gone has none to offer.
    records.vacate(db, "c1");
    expect(records.sendersOn("telegram")).toEqual([own]);
    records.vacate(db, "c2");
    expect(records.sendersOn("telegram")).toEqual([]);
  });

  it("names Rome's own account on a channel once its record knows one", () => {
    const records = repository();
    const db = testDb!.db;
    const unknown = records.claim(db, { id: "c1", connectionKind: "telegram" }, NOW).id;
    const own = records.claim(
      db,
      {
        id: "c2",
        connectionKind: "telegram_user",
        account: { platform: "telegram", accountId: "5550" },
      },
      NOW,
    ).id;

    expect(records.accountOf(own)).toEqual({ platform: "telegram", id: "5550" });
    expect(records.accountOf(unknown)).toBeNull();
    expect(records.accountOf("webchat")).toBeNull();
  });

  it("keeps a Connection's channel name current across claims and releases", () => {
    const records = repository();
    const db = testDb!.db;
    expect(records.idOf("c1")).toBeNull();

    records.claim(db, { id: "c1", connectionKind: "feishu" }, NOW, { id: "feishu" });
    expect(records.idOf("c1")).toBe("feishu");

    records.vacate(db, "c1");
    expect(records.idOf("c1")).toBeNull();
  });

  it("caches no name read inside a transaction that rolls back", () => {
    const records = repository();
    const db = testDb!.db;

    expect(() =>
      db.transaction((tx) => {
        records.claim(tx, { id: "c1", connectionKind: "feishu" }, NOW, { id: "feishu" });
        expect(records.idOf("c1")).toBe("feishu");
        throw new Error("rollback");
      }),
    ).toThrow("rollback");

    expect(records.idOf("c1")).toBeNull();
  });

  it("lists the Connections no channel records yet", () => {
    const records = repository();
    records.claim(testDb!.db, { id: "c1", connectionKind: "feishu" }, NOW, { id: "feishu" });

    expect(
      records.unclaimed([
        { id: "c1", connectionKind: "feishu" },
        { id: "c2", connectionKind: "discord" },
      ]),
    ).toEqual([{ id: "c2", connectionKind: "discord" }]);
  });
});
