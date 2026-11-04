import { afterEach, describe, expect, it } from "@rstest/core";
import type { GrantValue } from "../connections/grant.js";
import { DrizzleConnectionsRepository } from "../connections/repository-db.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { byAccount } from "./account-agents.js";
import { romeAccounts } from "./rome-accounts.js";

const TG = { platform: "telegram", id: "8123" };

function held(account?: { platform: string; accountId: string }): GrantValue {
  return {
    state: "authorized",
    credential: { material: { kind: "inline", record: { token: "t" } }, expiresAt: "never" },
    ...(account ? { account } : {}),
  };
}

describe("romeAccounts", () => {
  let testDb: TestDb | undefined;
  afterEach(() => {
    testDb?.close();
    testDb = undefined;
  });

  function setup() {
    testDb = createTestDb();
    const db = testDb.db;
    const store = new DrizzleConnectionsRepository(db);
    const save = (id: string, grant: GrantValue) =>
      store.save(db, {
        id,
        connectionKind: "telegram",
        label: "Telegram",
        createdAt: new Date(0),
        grant,
      });
    return { store, save, accounts: romeAccounts(store) };
  }

  it("answers the account a held grant reaches, and the connection that reaches it", () => {
    const { save, accounts } = setup();
    save("c1", held({ platform: "telegram", accountId: "8123" }));
    save("c2", held());

    expect(accounts.accountOf("c1")).toEqual(TG);
    expect(accounts.holderOf(TG)).toBe("c1");
    expect(accounts.accountOf("c2")).toBeNull();
    expect(accounts.holderOf({ platform: "telegram", id: "999" })).toBeNull();
    expect(accounts.holderOf({ platform: "discord", id: "8123" })).toBeNull();
  });

  it("answers no account for an unauthorized grant", () => {
    const { save, accounts } = setup();
    save("c1", { ...held({ platform: "telegram", accountId: "8123" }), state: "unauthorized" });

    expect(accounts.accountOf("c1")).toBeNull();
    expect(accounts.holderOf(TG)).toBeNull();
  });
});

describe("byAccount", () => {
  const holderOf = (account: { platform: string; id: string }) =>
    account.platform === TG.platform && account.id === TG.id ? "c1" : null;
  const agentOf = byAccount(
    { holderOf },
    (connectionId) => `agent of ${connectionId}`,
    (channel) => `agent of channel ${channel}`,
  );

  it("answers for the connection that reaches the account", () => {
    expect(agentOf({ ...TG })).toBe("agent of c1");
  });

  it("answers null for an account no connection of Rome's reaches", () => {
    expect(agentOf({ platform: "telegram", id: "999" })).toBeNull();
  });

  it("answers a channel's name by the channel", () => {
    expect(agentOf("feishu-2")).toBe("agent of channel feishu-2");
  });
});
