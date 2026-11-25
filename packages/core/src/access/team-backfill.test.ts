import { afterEach, describe, expect, it } from "@rstest/core";
import {
  guardianAuth,
  identities,
  identityAccounts,
  links,
  persons,
  settings,
  teamMembers,
  visitorProfiles,
} from "../db/schema.js";
import type { DrizzleDb } from "../db/index.js";
import { createTestDb, type TestDb } from "../test/db.js";
import { DASHBOARD_ACCESS_SETTING_KEY } from "./dashboard-access-config.js";
import { backfillTeam } from "./team-backfill.js";
import { createTeam } from "./team-members.js";

const now = new Date("2026-11-25T00:00:00Z");

function seed(db: DrizzleDb) {
  db.insert(guardianAuth)
    .values({
      id: "seat",
      userId: "acct-owner",
      passwordHash: "x",
      accountId: "acct-owner",
      email: "Owner@Example.com",
      avatarUrl: "https://example.com/owner.png",
      createdAt: now,
    })
    .run();
  db.insert(persons)
    .values([
      { id: "p-owner", displayName: "Olive", bondLevel: "guardian", createdAt: now },
      { id: "p-friend", displayName: "Fred", bondLevel: "inner-circle", createdAt: now },
    ])
    .run();
  db.insert(links)
    .values([
      { id: "l1", personId: "p-owner", platform: "slack", accountId: "T1:U1" },
      { id: "l2", personId: "p-owner", platform: "telegram", accountId: "42" },
      // An agent's own account acting for the guardian is not the guardian's.
      { id: "l3", personId: "p-owner", platform: "slack", accountId: "T1:BOT", delegate: true },
      { id: "l4", personId: "p-friend", platform: "slack", accountId: "T1:U2" },
    ])
    .run();
  db.insert(settings)
    .values({
      key: DASHBOARD_ACCESS_SETTING_KEY,
      value: {
        cloudEmailAccess: ["ada@example.com", "lin@example.com", "owner@example.com"],
        revision: 3,
      },
      updatedAt: now,
    })
    .run();
  db.insert(visitorProfiles)
    .values([
      { accountId: "acct-ada", email: "ada@example.com", avatarUrl: null, updatedAt: now },
      // The guardian's own Rome Cloud account stays the guardian's.
      { accountId: "acct-owner", email: "lin@example.com", avatarUrl: null, updatedAt: now },
      // A visitor off the list gets no person.
      { accountId: "acct-zed", email: "zed@example.com", avatarUrl: null, updatedAt: now },
    ])
    .run();
}

function snapshot(db: DrizzleDb) {
  return {
    identities: db.select().from(identities).orderBy(identities.id).all(),
    accounts: db
      .select()
      .from(identityAccounts)
      .orderBy(identityAccounts.platform, identityAccounts.accountId)
      .all(),
    team: db.select().from(teamMembers).orderBy(teamMembers.identityId).all(),
  };
}

describe("backfillTeam", () => {
  let testDb: TestDb | undefined;
  afterEach(() => {
    testDb?.close();
    testDb = undefined;
  });

  it("puts the seat, People's guardian links and the allow-list on the team, and a second run changes nothing", async () => {
    testDb = createTestDb();
    const { db } = testDb;
    seed(db);

    await backfillTeam(db);

    const members = await createTeam(db).members();
    expect(
      members.map((m) => ({
        name: m.identity.name,
        avatarUrl: m.identity.avatarUrl,
        role: m.role,
        accounts: m.accounts.map((a) => `${a.platform}:${a.accountId}`),
      })),
    ).toEqual([
      {
        name: "Olive",
        avatarUrl: "https://example.com/owner.png",
        role: "guardian",
        accounts: [
          "email:owner@example.com",
          "rome-cloud:acct-owner",
          "slack:T1:U1",
          "telegram:42",
        ],
      },
      {
        name: null,
        avatarUrl: null,
        role: "teammate",
        accounts: ["email:ada@example.com", "rome-cloud:acct-ada"],
      },
      { name: null, avatarUrl: null, role: "teammate", accounts: ["email:lin@example.com"] },
    ]);

    const first = snapshot(db);
    await backfillTeam(db);
    expect(snapshot(db)).toEqual(first);
  });

  it("takes a teammate off the list off the team on the next run", async () => {
    testDb = createTestDb();
    const { db } = testDb;
    seed(db);
    await backfillTeam(db);

    db.update(settings)
      .set({ value: { cloudEmailAccess: ["lin@example.com"], revision: 4 } })
      .run();
    await backfillTeam(db);

    const team = createTeam(db);
    expect(await team.roleOf({ platform: "email", accountId: "ada@example.com" })).toBeNull();
    expect(await team.roleOf({ platform: "rome-cloud", accountId: "acct-ada" })).toBeNull();
    expect(await team.roleOf({ platform: "email", accountId: "lin@example.com" })).toBe("teammate");
  });

  it("writes nothing on an instance with no seat and no list", async () => {
    testDb = createTestDb();
    await backfillTeam(testDb.db);
    expect(snapshot(testDb.db)).toEqual({ identities: [], accounts: [], team: [] });
  });
});
