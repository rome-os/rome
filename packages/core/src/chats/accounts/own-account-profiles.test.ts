// Seam under test: the account profile cache learning the name a grant reports
// for Rome's own account, at connect and fix through the registry's events and
// at boot from held grants. Observed through the connected account list, which
// is what Envoys shows after a disconnect.

import { afterEach, describe, expect, it } from "@rstest/core";
import { ConnectionRegistry } from "../../connections/registry.js";
import { DrizzleConnectionsRepository } from "../../connections/repository-db.js";
import { makePasteTalk } from "../../connections/test-fixtures.js";
import type { ConnectionDescriptor, Credential, ProfileRecord } from "../../connections/types.js";
import { AccountProfilesRepository } from "../../db/repositories/account-profiles.js";
import { ConnectedAccountsRepository } from "../../db/repositories/connected-accounts.js";
import { createTestDb, type TestDb } from "../../test/db.js";
import { backfillOwnAccountProfiles, rememberOwnAccountProfile } from "./own-account-profiles.js";

const SERVICE = "fake-telegram";

const credential: Credential = { material: { token: "t" }, expiresAt: "never" };

/** The paste-talk descriptor, displaying a bot by the profile's `username`. */
function namedBotDescriptor(): ConnectionDescriptor {
  const { descriptor } = makePasteTalk();
  return {
    ...descriptor,
    severalAccounts: true,
    reviveProfile: (record: ProfileRecord) => {
      if (typeof record.username !== "string") throw new Error("no username");
      return {
        displayName: undefined,
        handle: record.username,
        email: undefined,
        avatarUrl: undefined,
      };
    },
  };
}

describe("own account profiles", () => {
  let testDb: TestDb | undefined;
  afterEach(() => {
    testDb?.close();
    testDb = undefined;
  });

  /** A registry wired the way index.ts wires it: each connect and fix records
   *  the connected account and the name its grant reports. */
  function setup() {
    testDb = createTestDb();
    const { db } = testDb;
    const ledger = new DrizzleConnectionsRepository(db);
    const accounts = new ConnectedAccountsRepository(db);
    const profiles = new AccountProfilesRepository(db);
    const descriptor = namedBotDescriptor();
    const registry: ConnectionRegistry = new ConnectionRegistry({
      repository: ledger,
      onEvent: (tx, event) => {
        if (event.kind !== "connected" && event.kind !== "fixed") return;
        accounts.add(tx, event.connection.id);
        rememberOwnAccountProfile(profiles, tx, descriptor, event.account, event.profile);
      },
    });
    registry.register(descriptor);
    return { db, ledger, accounts, profiles, descriptor, registry };
  }

  it("names a bot by its grant's profile after it is disconnected", async () => {
    const { accounts, registry } = setup();
    const conn = await registry.connect(SERVICE);
    await registry.giveGrant(SERVICE, conn.id, "bot", credential, {
      botId: "100",
      username: "sales_bot",
    });

    await registry.disconnect(conn.id);

    expect(accounts.all()).toEqual([
      { platform: SERVICE, accountId: "100", agent: null, connectionId: null, name: "sales_bot" },
    ]);
  });

  it("takes the name a fix reports for the same bot", async () => {
    const { accounts, registry } = setup();
    const conn = await registry.connect(SERVICE);
    await registry.giveGrant(SERVICE, conn.id, "bot", credential, {
      botId: "100",
      username: "sales_bot",
    });

    await registry.giveGrant(SERVICE, conn.id, "bot", credential, {
      botId: "100",
      username: "sales_desk_bot",
    });

    expect(accounts.all()).toMatchObject([{ accountId: "100", name: "sales_desk_bot" }]);
  });

  it("connects a bot whose profile fails its schema, naming it by its id", async () => {
    const { accounts, registry } = setup();
    const conn = await registry.connect(SERVICE);

    await registry.giveGrant(SERVICE, conn.id, "bot", credential, { botId: "100" });

    expect(accounts.all()).toMatchObject([{ accountId: "100", connectionId: conn.id, name: null }]);
  });

  it("learns the names of grants held before the cache learned from grants", async () => {
    testDb = createTestDb();
    const { db } = testDb;
    const ledger = new DrizzleConnectionsRepository(db);
    const accounts = new ConnectedAccountsRepository(db);
    const profiles = new AccountProfilesRepository(db);
    const descriptor = namedBotDescriptor();
    // A registry that predates the cache's grant writer.
    const registry = new ConnectionRegistry({
      repository: ledger,
      onEvent: (tx, event) => {
        if (event.kind === "connected" || event.kind === "fixed") {
          accounts.add(tx, event.connection.id);
        }
      },
    });
    registry.register(descriptor);
    const conn = await registry.connect(SERVICE);
    await registry.giveGrant(SERVICE, conn.id, "bot", credential, {
      botId: "100",
      username: "sales_bot",
    });
    expect(accounts.all()).toMatchObject([{ name: null }]);

    backfillOwnAccountProfiles(profiles, db, await ledger.all(), () => descriptor);
    await registry.disconnect(conn.id);

    expect(accounts.all()).toMatchObject([
      { accountId: "100", connectionId: null, name: "sales_bot" },
    ]);
  });

  it("keeps a name a message taught after the grant when it backfills at boot", async () => {
    const { db, ledger, profiles, descriptor, registry } = setup();
    const conn = await registry.connect(SERVICE);
    await registry.giveGrant(SERVICE, conn.id, "bot", credential, {
      botId: "100",
      username: "sales_bot",
    });
    await profiles.fromMessage(
      { platform: SERVICE, id: "100" },
      { displayName: null, handle: "sales_desk_bot", avatarUrl: null },
    );

    backfillOwnAccountProfiles(profiles, db, await ledger.all(), () => descriptor);

    const [profile] = await profiles.profilesOf([{ platform: SERVICE, id: "100" }]);
    expect(profile?.handle).toBe("sales_desk_bot");
  });
});
