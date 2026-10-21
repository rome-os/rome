import { afterEach, describe, expect, it } from "@rstest/core";
import { DrizzleGrantLedger } from "../connections/ledger-db.js";
import { ChannelRecordsRepository } from "../db/repositories/channel-records.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { claimChannels } from "./claim-channels.js";
import { domainOfGrants } from "./platform.js";

describe("claimChannels", () => {
  let testDb: TestDb | undefined;
  afterEach(() => {
    testDb?.close();
    testDb = undefined;
  });

  it("names each unrecorded Connection after its service and keeps recorded ones", async () => {
    testDb = createTestDb();
    const records = new ChannelRecordsRepository(testDb.db);
    records.claim(testDb.db, { id: "c1", connectionKind: "feishu" }, new Date());

    await claimChannels(testDb.db, records, [
      { id: "c1", connectionKind: "feishu" },
      { id: "c2", connectionKind: "telegram" },
      { id: "c3", connectionKind: "discord" },
    ]);

    expect(records.byConnection("c1")?.id).toBe("feishu");
    expect(records.byConnection("c2")?.id).toBe("telegram");
    expect(records.byConnection("c3")?.id).toBe("discord");
    // They answered as main before accounts took agents.
    expect(records.byConnection("c2")?.agent).toBe("core:main");
    expect(records.all()).toHaveLength(3);
  });

  it("asks only unrecorded Connections their domain, and puts a Lark app on Lark", async () => {
    testDb = createTestDb();
    const records = new ChannelRecordsRepository(testDb.db);
    records.claim(testDb.db, { id: "c1", connectionKind: "telegram" }, new Date());
    const asked: string[] = [];

    await claimChannels(
      testDb.db,
      records,
      [
        { id: "c1", connectionKind: "telegram" },
        { id: "c2", connectionKind: "feishu" },
      ],
      async (id) => {
        asked.push(id);
        return "lark";
      },
    );

    expect(asked).toEqual(["c2"]);
    expect(records.byConnection("c2")?.platform).toBe("lark");
  });

  it("puts a pre-profile Lark grant on Lark when boot claims its channel after the migrations", async () => {
    // createTestDb has run every migration, 0083 included, and found no
    // channel to move, so the boot pass alone decides this channel's platform.
    testDb = createTestDb();
    const ledger = new DrizzleGrantLedger(testDb.db);
    ledger.writeConnection(testDb.db, {
      id: "c1",
      connectionKind: "feishu",
      label: "Lark",
      createdAt: new Date(),
    });
    ledger.writeEnsureGrant(testDb.db, "c1", "app");
    ledger.writeGrant(testDb.db, "c1", "app", {
      state: "authorized",
      credential: {
        material: { kind: "inline", record: { appId: "a", domain: "lark" } },
        expiresAt: "never",
      },
    });
    const records = new ChannelRecordsRepository(testDb.db);

    await claimChannels(testDb.db, records, [{ id: "c1", connectionKind: "feishu" }], async (id) =>
      domainOfGrants(await ledger.listGrants(id)),
    );

    expect(records.byConnection("c1")?.platform).toBe("lark");
  });
});
