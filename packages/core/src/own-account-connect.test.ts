// What a connect tells Identity about whose account it is, through the setup
// as the wiring builds it: a bot or an app tells nothing, and a connection
// signed in as the guardian's own account makes that account the guardian's.

import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { sql } from "drizzle-orm";
import { createLinkedInDescriptor } from "./connections/kinds/linkedin/descriptor.js";
import type { LinkedInSyncSink } from "./connections/kinds/linkedin/linkedin-sync.js";
import { DrizzleConnectionsRepository } from "./connections/repository-db.js";
import { ConnectionRegistry } from "./connections/registry.js";
import { SetupManager } from "./connections/setup/manager.js";
import type { SetupFn } from "./connections/setup/types.js";
import { makePasteTalk } from "./connections/test-fixtures.js";
import { links, persons } from "./db/schema.js";
import {
  accountCodeContext,
  accountCodeIssued,
  accountCodeRedeemed,
} from "./identity/application/account-codes.js";
import { createTestDb, type TestDb } from "./test/db.js";
import { guardianSeatCreated, memberContext, roleOfAccount } from "./access/application/members.js";
import { ownAccountConnected } from "./access/application/own-account-connect.js";

const KIND = "fake-telegram";

/** A setup that reaches the account `reached`, given by the account `by`;
 *  each defaults to the account id typed in. */
function setupReaching(reached?: string, by?: string): SetupFn {
  return async (interact) => {
    const { id } = await interact.prompt({
      fields: [{ name: "id", label: "Account id", secret: false }],
    });
    return {
      credential: { material: { token: "t" }, expiresAt: "never" },
      profile: { botId: reached ?? id },
      connectedBy: { id: by ?? id ?? "" },
    };
  };
}

describe("ownAccountConnected", () => {
  let testDb: TestDb | undefined;
  afterEach(() => {
    testDb?.close();
    testDb = undefined;
  });

  async function connect(setup: SetupFn) {
    testDb = createTestDb();
    const { db } = testDb;
    const members = memberContext(db);
    const guardian = await guardianSeatCreated(members, { accounts: [] });
    const registry = new ConnectionRegistry({ repository: new DrizzleConnectionsRepository(db) });
    const { descriptor } = makePasteTalk();
    registry.register({
      ...descriptor,
      accountIdOf: (profile) => (typeof profile.botId === "string" ? profile.botId : null),
      auth: { ...descriptor.auth, setup },
    });
    const manager = new SetupManager({ registry, participant: ownAccountConnected() });
    return {
      db,
      members,
      guardian,
      registry,
      run: async (id = "", connectionId?: string) => {
        const started = await manager.start({ connectionKind: KIND, connectionId }, "bot");
        return (await manager.provideInput(started.cid, { id }))?.state.status;
      },
    };
  }

  it("leaves the account that connected a bot unknown, until its code makes it the guardian's", async () => {
    const { db, members, guardian, run } = await connect(setupReaching("bot-1", "owner-7"));
    const owner = { platform: KIND, accountId: "owner-7" };

    expect(await run()).toBe("done");
    expect(await members.identity.personOf(owner)).toBeNull();
    expect(await members.identity.personOf({ platform: KIND, accountId: "bot-1" })).toBeNull();

    const codes = accountCodeContext(db);
    const { code } = await accountCodeIssued(codes, guardian.id);
    await accountCodeRedeemed(codes, code, owner);
    expect(await roleOfAccount(members, owner)).toBe("guardian");
  });

  it("makes the account a connection is signed in as the guardian's at once, writing nothing to People", async () => {
    const { db, members, run } = await connect(setupReaching("self-7", "self-7"));

    expect(await run()).toBe("done");
    expect(await roleOfAccount(members, { platform: KIND, accountId: "self-7" })).toBe("guardian");
    expect(db.select().from(persons).all()).toEqual([]);
    expect(db.select().from(links).all()).toEqual([]);
  });

  it("keeps the guardian's account a fix ended, beside the one it reached", async () => {
    const { members, guardian, registry, run } = await connect(setupReaching());
    await run("100");
    await run("900", registry.find(KIND)[0]?.id);

    expect(
      (await members.identity.accountsOf(guardian.id)).map((account) => account.accountId),
    ).toEqual(["100", "900"]);
  });

  it("fails the connect and keeps no credential when Identity cannot be written", async () => {
    const { db, members, registry, run } = await connect(setupReaching("self-7", "self-7"));
    db.run(
      sql`CREATE TRIGGER refuse_accounts BEFORE INSERT ON identity_accounts BEGIN SELECT RAISE(ABORT, 'identity write failed'); END`,
    );

    expect(await run()).toBe("failed");
    expect(registry.find(KIND)).toEqual([]);
    expect(await members.identity.personOf({ platform: KIND, accountId: "self-7" })).toBeNull();
  });
});

describe("a LinkedIn connect", () => {
  let testDb: TestDb | undefined;
  afterEach(() => {
    testDb?.close();
    testDb = undefined;
  });

  it("makes the account the guardian's when LinkedIn names only its public id", async () => {
    testDb = createTestDb();
    const members = memberContext(testDb.db);
    await guardianSeatCreated(members, { accounts: [] });
    const store = new DrizzleConnectionsRepository(testDb.db);
    const registry = new ConnectionRegistry({ repository: store });
    registry.register(
      createLinkedInDescriptor({
        syncSink: {} as LinkedInSyncSink,
        minIntervalMs: 60_000,
        maxIntervalMs: 60_000,
        run: async () => ({
          code: 0,
          stdout: JSON.stringify({ logged_in: true, public_id: "ada-lovelace", name: "Ada" }),
          stderr: "",
        }),
        openLoginTab: async () => true,
      }),
    );
    const manager = new SetupManager({ registry, participant: ownAccountConnected() });

    const started = await manager.start({ connectionKind: "linkedin" }, "session");
    await rs.waitFor(() => expect(manager.state(started.cid)?.status).toBe("done"));

    const account = {
      platform: "linkedin",
      accountId: "https://www.linkedin.com/in/ada-lovelace/",
    };
    expect(await roleOfAccount(members, account)).toBe("guardian");
    const [connection] = registry.find("linkedin");
    expect(connection && store.accountOf(connection.id)).toEqual(account);
  });
});
