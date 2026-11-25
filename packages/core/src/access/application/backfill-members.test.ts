import { afterEach, describe, expect, it } from "@rstest/core";
import {
  guardianAuth,
  identities,
  identityAccounts,
  links,
  persons,
  settings,
  members,
  visitorProfiles,
} from "../../db/schema.js";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb, type TestDb } from "../../test/db.js";
import { DASHBOARD_ACCESS_SETTING_KEY } from "../dashboard-access-config.js";
import { backfillMembers } from "./backfill-members.js";
import { listMembers, memberContext, roleOfAccount } from "./members.js";

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
    members: db.select().from(members).orderBy(members.identityId).all(),
  };
}

describe("backfillMembers", () => {
  let testDb: TestDb | undefined;
  afterEach(() => {
    testDb?.close();
    testDb = undefined;
  });

  it("gives the seat's guardian People's guardian links and makes the allow-list members, and a second run changes nothing", async () => {
    testDb = createTestDb();
    const { db } = testDb;
    seed(db);

    await backfillMembers(db);

    const listed = await listMembers(memberContext(db));
    expect(
      listed.map((m) => ({
        name: m.person.name,
        avatarUrl: m.person.avatarUrl,
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
        role: "member",
        accounts: ["email:ada@example.com", "rome-cloud:acct-ada"],
      },
      { name: null, avatarUrl: null, role: "member", accounts: ["email:lin@example.com"] },
    ]);

    const first = snapshot(db);
    await backfillMembers(db);
    expect(snapshot(db)).toEqual(first);
  });

  it("removes a member off the list on the next run", async () => {
    testDb = createTestDb();
    const { db } = testDb;
    seed(db);
    await backfillMembers(db);

    db.update(settings)
      .set({ value: { cloudEmailAccess: ["lin@example.com"], revision: 4 } })
      .run();
    await backfillMembers(db);

    const ctx = memberContext(db);
    expect(
      await roleOfAccount(ctx, { platform: "email", accountId: "ada@example.com" }),
    ).toBeNull();
    expect(await roleOfAccount(ctx, { platform: "rome-cloud", accountId: "acct-ada" })).toBeNull();
    expect(await roleOfAccount(ctx, { platform: "email", accountId: "lin@example.com" })).toBe(
      "member",
    );
  });

  it("gives the guardian a rebound seat's accounts and takes away none it cannot tell came from the seat", async () => {
    testDb = createTestDb();
    const { db } = testDb;
    seed(db);
    db.insert(links)
      .values({ id: "l5", personId: "p-owner", platform: "email", accountId: "olive@example.com" })
      .run();
    await backfillMembers(db);

    // The seat moved while its step beside the write failed.
    db.update(guardianAuth).set({ accountId: "acct-new", email: "new@example.com" }).run();
    await backfillMembers(db);

    const guardian = (await listMembers(memberContext(db)))[0];
    expect(guardian?.role).toBe("guardian");
    expect(guardian?.accounts.map((a) => `${a.platform}:${a.accountId}`)).toEqual([
      "email:new@example.com",
      "email:olive@example.com",
      "email:owner@example.com",
      "rome-cloud:acct-new",
      "rome-cloud:acct-owner",
      "slack:T1:U1",
      "telegram:42",
    ]);
  });

  it("writes nothing on an instance with no seat and no list", async () => {
    testDb = createTestDb();
    await backfillMembers(testDb.db);
    expect(snapshot(testDb.db)).toEqual({ identities: [], accounts: [], members: [] });
  });
});
