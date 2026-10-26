import { afterEach, describe, expect, it } from "@rstest/core";
import { DrizzleGrantLedger } from "../connections/ledger-db.js";
import type { GrantRecord } from "../connections/ledger.js";
import { ChannelRecordsRepository } from "../db/repositories/channel-records.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { claimChannels, recordChannelAccounts } from "./claim-channels.js";
import { domainOfGrant } from "./platform.js";

/** The connected accounts made, by connection, with their agent. */
function recordedAccounts() {
  const added = new Map<string, string | null>();
  return {
    added,
    add: (_exec: unknown, connectionId: string, agent: string | null = null) => {
      added.set(connectionId, agent);
    },
  };
}

describe("claimChannels", () => {
  let testDb: TestDb | undefined;
  afterEach(() => {
    testDb?.close();
    testDb = undefined;
  });

  it("names each unrecorded Connection after its service and keeps recorded ones", async () => {
    testDb = createTestDb();
    const records = new ChannelRecordsRepository(testDb.db);
    const accounts = recordedAccounts();
    records.claim(testDb.db, { id: "c1", connectionKind: "feishu" }, new Date(), { id: "feishu" });

    await claimChannels(testDb.db, records, accounts, [
      { id: "c1", connectionKind: "feishu" },
      { id: "c2", connectionKind: "telegram" },
      { id: "c3", connectionKind: "discord" },
      { id: "c4", connectionKind: "email" },
    ]);

    expect(records.byConnection("c1")?.id).toBe("feishu");
    expect(records.byConnection("c2")?.id).toBe("telegram");
    expect(records.byConnection("c3")?.id).toBe("discord");
    // They answered as main before accounts took agents. An email account
    // takes no agent, and a recorded Connection already has its account.
    expect(accounts.added).toEqual(
      new Map([
        ["c2", "core:main"],
        ["c3", "core:main"],
        ["c4", null],
      ]),
    );
    expect(records.all()).toHaveLength(4);
  });

  it("asks only unrecorded Connections their domain, and puts a Lark app on Lark", async () => {
    testDb = createTestDb();
    const records = new ChannelRecordsRepository(testDb.db);
    records.claim(testDb.db, { id: "c1", connectionKind: "telegram" }, new Date(), {
      id: "telegram",
    });
    const asked: string[] = [];

    await claimChannels(
      testDb.db,
      records,
      recordedAccounts(),
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
    ledger.writeEnsureGrant(testDb.db, "c1");
    ledger.writeGrant(testDb.db, "c1", {
      state: "authorized",
      credential: {
        material: { kind: "inline", record: { appId: "a", domain: "lark" } },
        expiresAt: "never",
      },
    });
    const records = new ChannelRecordsRepository(testDb.db);

    await claimChannels(
      testDb.db,
      records,
      recordedAccounts(),
      [{ id: "c1", connectionKind: "feishu" }],
      async (id) => domainOfGrant(await ledger.getGrant(id)),
    );

    expect(records.byConnection("c1")?.platform).toBe("lark");
  });

  it("records the account each backed channel's Connection reaches", async () => {
    testDb = createTestDb();
    const records = new ChannelRecordsRepository(testDb.db);
    const now = new Date();
    const tg = records.claim(testDb.db, { id: "c1", connectionKind: "telegram" }, now).id;
    const email = records.claim(testDb.db, { id: "c2", connectionKind: "email" }, now).id;
    const discord = records.claim(testDb.db, { id: "c3", connectionKind: "discord" }, now).id;
    const grants: Record<string, GrantRecord> = {
      c1: grant("c1", "authorized", { platform: "telegram", accountId: "bot-1" }),
      c2: grant("c2", "unauthorized", { platform: "email", accountId: "a@x.test" }),
      c3: grant("c3", "degraded"),
    };

    await recordChannelAccounts(testDb.db, records, {
      getGrant: async (id) => grants[id] ?? null,
    });

    // Read by id: these grants are not in the ledger, so none reaches the account.
    expect(records.byId(tg)?.platformAccountId).toBe("bot-1");
    // A grant given up reaches no account, and a grant naming none tells nothing.
    expect(records.byId(email)?.platformAccountId).toBeNull();
    expect(records.byId(discord)?.platformAccountId).toBeNull();
  });
});

function grant(
  custody: string,
  state: GrantRecord["state"],
  account?: GrantRecord["account"],
): GrantRecord {
  return { custody, state, account };
}
