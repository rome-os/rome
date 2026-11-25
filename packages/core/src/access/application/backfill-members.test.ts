import { afterEach, describe, expect, it } from "@rstest/core";
import { eq } from "drizzle-orm";
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
        accounts: ["rome-cloud-email:owner@example.com", "slack:T1:U1", "telegram:42"],
      },
      {
        name: null,
        avatarUrl: null,
        role: "member",
        accounts: ["rome-cloud-email:ada@example.com"],
      },
      {
        name: null,
        avatarUrl: null,
        role: "member",
        accounts: ["rome-cloud-email:lin@example.com"],
      },
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
      await roleOfAccount(ctx, { platform: "rome-cloud-email", accountId: "ada@example.com" }),
    ).toBeNull();
    expect(
      await roleOfAccount(ctx, { platform: "rome-cloud-email", accountId: "lin@example.com" }),
    ).toBe("member");
  });

  it("gives the guardian's person the avatar a visitor signed in with under the guardian's listed email", async () => {
    testDb = createTestDb();
    const { db } = testDb;
    seed(db);
    db.insert(visitorProfiles)
      .values({
        accountId: "acct-visitor",
        email: "OWNER@example.com",
        avatarUrl: "https://example.com/visitor.png",
        updatedAt: now,
      })
      .run();

    await backfillMembers(db);

    const listed = await listMembers(memberContext(db));
    expect(listed[0]?.role).toBe("guardian");
    expect(listed[0]?.person.avatarUrl).toBe("https://example.com/visitor.png");
    expect(db.select().from(identities).all()).toHaveLength(3);
  });

  it("takes every stored Rome Cloud id from every person, and a second run changes nothing", async () => {
    testDb = createTestDb();
    const { db } = testDb;
    seed(db);
    await backfillMembers(db);
    const ctx = memberContext(db);
    const [guardian, ada] = await listMembers(ctx);
    // Stored by an earlier build as accounts.
    await ctx.identity.addAccount(guardian?.person.id ?? "", {
      platform: "rome-cloud",
      accountId: "acct-owner",
    });
    await ctx.identity.addAccount(ada?.person.id ?? "", {
      platform: "rome-cloud",
      accountId: "acct-ada",
    });
    await ctx.identity.createPerson({
      accounts: [{ platform: "rome-cloud", accountId: "acct-stray" }],
    });

    await backfillMembers(db);

    expect(
      db.select().from(identityAccounts).where(eq(identityAccounts.platform, "rome-cloud")).all(),
    ).toEqual([]);
    expect(
      await roleOfAccount(ctx, { platform: "rome-cloud-email", accountId: "owner@example.com" }),
    ).toBe("guardian");
    expect(
      await roleOfAccount(ctx, { platform: "rome-cloud-email", accountId: "ada@example.com" }),
    ).toBe("member");
    const first = snapshot(db);
    await backfillMembers(db);
    expect(snapshot(db)).toEqual(first);
  });

  it("gives the guardian a rebound seat's email and takes no email away", async () => {
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
      "email:olive@example.com",
      "rome-cloud-email:new@example.com",
      "rome-cloud-email:owner@example.com",
      "slack:T1:U1",
      "telegram:42",
    ]);
  });

  it("moves each member's email account to the sign-in platform, and a second run changes nothing", async () => {
    testDb = createTestDb();
    const { db } = testDb;
    seed(db);
    // An earlier build invited members under `email`.
    const ctx = memberContext(db);
    const ada = await ctx.identity.createPerson({
      avatarUrl: "https://example.com/ada.png",
      accounts: [{ platform: "email", accountId: "ada@example.com" }],
    });
    await ctx.access.grant(ada.id, "member");

    await backfillMembers(db);

    expect(
      await roleOfAccount(ctx, { platform: "email", accountId: "ada@example.com" }),
    ).toBeNull();
    const member = (await listMembers(ctx)).find((m) => m.person.id === ada.id);
    expect(member).toEqual({
      person: { id: ada.id, name: null, avatarUrl: "https://example.com/ada.png" },
      role: "member",
      accounts: [{ platform: "rome-cloud-email", accountId: "ada@example.com" }],
    });
    const first = snapshot(db);
    await backfillMembers(db);
    expect(snapshot(db)).toEqual(first);
  });

  it("takes the seat's address as an email account from the guardian, unless People links it", async () => {
    for (const linkedByPeople of [false, true]) {
      testDb?.close();
      testDb = createTestDb();
      const { db } = testDb;
      seed(db);
      const ctx = memberContext(db);
      // An earlier build gave the guardian the seat's email under `email`.
      const owner = await ctx.identity.createPerson({
        accounts: [{ platform: "email", accountId: "owner@example.com" }],
      });
      await ctx.access.grant(owner.id, "guardian");
      if (linkedByPeople) {
        db.insert(links)
          .values({
            id: "l5",
            personId: "p-owner",
            platform: "email",
            accountId: "Owner@Example.com",
          })
          .run();
      }

      await backfillMembers(db);

      const accounts = (await listMembers(ctx))[0]?.accounts.map(
        (a) => `${a.platform}:${a.accountId}`,
      );
      expect(accounts).toEqual([
        ...(linkedByPeople ? ["email:owner@example.com"] : []),
        "rome-cloud-email:owner@example.com",
        "slack:T1:U1",
        "telegram:42",
      ]);
      const first = snapshot(db);
      await backfillMembers(db);
      expect(snapshot(db)).toEqual(first);
    }
  });

  it("writes nothing on an instance with no seat and no list", async () => {
    testDb = createTestDb();
    await backfillMembers(testDb.db);
    expect(snapshot(testDb.db)).toEqual({ identities: [], accounts: [], members: [] });
  });
});
