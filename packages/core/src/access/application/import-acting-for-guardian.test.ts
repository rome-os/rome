import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { accountsActingForGuardian, links, persons } from "../../db/schema.js";
import { createTestDb, type TestDb } from "../../test/db.js";
import { actsForGuardian } from "../acts-for-guardian.js";
import { importActingForGuardian } from "./import-acting-for-guardian.js";

describe("importActingForGuardian", () => {
  let testDb: TestDb;
  beforeEach(() => {
    testDb = createTestDb();
    const now = new Date();
    testDb.db
      .insert(persons)
      .values([
        { id: "p-owner", displayName: "Olive", bondLevel: "guardian", createdAt: now },
        { id: "p-friend", displayName: "Fred", bondLevel: "inner-circle", createdAt: now },
      ])
      .run();
    testDb.db
      .insert(links)
      .values([
        {
          id: "l1",
          personId: "p-owner",
          platform: "agents",
          accountId: "ep-atlas",
          delegate: true,
        },
        { id: "l2", personId: "p-owner", platform: "slack", accountId: "T1:U1" },
        {
          id: "l3",
          personId: "p-friend",
          platform: "agents",
          accountId: "ep-fred",
          delegate: true,
        },
      ])
      .run();
  });
  afterEach(() => testDb.close());

  const acting = () =>
    testDb.db
      .select({
        platform: accountsActingForGuardian.platform,
        id: accountsActingForGuardian.accountId,
      })
      .from(accountsActingForGuardian)
      .all();

  it("makes a delegate link to the guardian the rule, and only that", () => {
    importActingForGuardian(testDb.db);

    expect(acting()).toEqual([{ platform: "agents", id: "ep-atlas" }]);
    expect(actsForGuardian(testDb.db, { platform: "agents", id: "ep-fred" })).toBe(false);
    expect(actsForGuardian(testDb.db, { platform: "slack", id: "T1:U1" })).toBe(false);
  });

  it("changes nothing when it runs again", () => {
    importActingForGuardian(testDb.db);
    const first = acting();

    importActingForGuardian(testDb.db);

    expect(acting()).toEqual(first);
  });
});
