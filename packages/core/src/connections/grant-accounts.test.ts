import { describe, expect, it } from "@rstest/core";
import { createTestDb } from "../test/helpers.js";
import { recordGrantAccounts } from "./grant-accounts.js";
import { DrizzleGrantLedger } from "./ledger-db.js";
import { ConnectionRegistry } from "./registry.js";
import { makePasteTalk } from "./test-fixtures.js";

const SERVICE = "fake-telegram";

/** A ledger whose grants were conferred before grants named their account. */
async function earlierGrants(botIds: string[]) {
  const db = createTestDb();
  const ledger = new DrizzleGrantLedger(db.db);
  const registry = new ConnectionRegistry({ ledger });
  registry.register({ ...makePasteTalk().descriptor, severalAccounts: true });
  const ids: string[] = [];
  for (const [i, botId] of botIds.entries()) {
    const id = `conn-${i}`;
    await ledger.createConnection({
      id,
      connectionKind: SERVICE,
      label: SERVICE,
      createdAt: new Date(1_000 * (i + 1)),
    });
    await ledger.ensureGrant(id);
    await ledger.updateGrant(id, (current) => ({
      ...current,
      state: "authorized",
      credential: { material: { kind: "inline", record: { token: `t-${i}` } }, expiresAt: "never" },
      profile: { botId },
    }));
    ids.push(id);
  }
  return { ...db, ledger, registry, ids };
}

describe("recordGrantAccounts", () => {
  it("records the account each held grant reaches", async () => {
    const { ledger, registry, ids, close } = await earlierGrants(["100", "200"]);
    try {
      expect(await recordGrantAccounts(registry)).toBe(2);
      expect((await ledger.getGrant(ids[1]!))?.account).toEqual({
        platform: SERVICE,
        accountId: "200",
      });
      expect(await recordGrantAccounts(registry)).toBe(0);
    } finally {
      close();
    }
  });

  it("gives an account two connections reach to the older one", async () => {
    const { ledger, registry, ids, close } = await earlierGrants(["100", "100"]);
    try {
      expect(await recordGrantAccounts(registry)).toBe(1);
      expect((await ledger.getGrant(ids[0]!))?.account?.accountId).toBe("100");
      expect((await ledger.getGrant(ids[1]!))?.account).toBeUndefined();
    } finally {
      close();
    }
  });

  it("keeps refusing an account the newer connection still reaches once the older one goes", async () => {
    const { registry, ids, close } = await earlierGrants(["100", "100"]);
    try {
      await recordGrantAccounts(registry);
      await registry.load();
      await registry.revoke(ids[0]!, "bot");
      const third = await registry.connectAnother(SERVICE);

      const refused = registry.confer(
        SERVICE,
        third.id,
        "bot",
        { material: { token: "t-3" }, expiresAt: "never" },
        { botId: "100" },
      );

      await expect(refused).rejects.toMatchObject({
        name: "AccountAlreadyConnectedError",
        connectionId: ids[1],
      });
    } finally {
      close();
    }
  });
});
