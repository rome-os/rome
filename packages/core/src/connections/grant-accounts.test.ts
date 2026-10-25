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
    await ledger.ensureGrant(id, "bot");
    await ledger.updateGrant(id, "bot", {
      state: "authorized",
      credential: { material: { kind: "inline", record: { token: `t-${i}` } }, expiresAt: "never" },
      profile: { botId },
    });
    ids.push(id);
  }
  return { ...db, ledger, registry, ids };
}

describe("recordGrantAccounts", () => {
  it("records the account each held grant reaches", async () => {
    const { ledger, registry, ids, close } = await earlierGrants(["100", "200"]);
    try {
      expect(await recordGrantAccounts(registry)).toBe(2);
      expect((await ledger.getGrant(ids[1]!, "bot"))?.account).toEqual({
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
      expect((await ledger.getGrant(ids[0]!, "bot"))?.account?.accountId).toBe("100");
      expect((await ledger.getGrant(ids[1]!, "bot"))?.account).toBeUndefined();
    } finally {
      close();
    }
  });
});
