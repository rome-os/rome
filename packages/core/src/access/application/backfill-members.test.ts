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
import { SettingsRepository } from "../../db/repositories/settings.js";
import {
  DASHBOARD_ACCESS_SETTING_KEY,
  normalizeDashboardAccessConfig,
} from "../dashboard-access-config.js";
import { DashboardAccessState } from "../dashboard-access-state.js";
import { DashboardAccessStore } from "../dashboard-access-store.js";
import { backfillMembers } from "./backfill-members.js";
import {
  guardianSeatRebound,
  listMembers,
  memberContext,
  roleOfAccount,
  seatAccounts,
} from "./members.js";

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
      // An agent's own account is the guardian's like any other.
      { id: "l3", personId: "p-owner", platform: "agents", accountId: "ep-atlas", delegate: true },
      { id: "l6", personId: "p-owner", platform: "rome-cloud", accountId: "acct-owner" },
      { id: "l4", personId: "p-friend", platform: "slack", accountId: "T1:U2" },
    ])
    .run();
  db.insert(settings)
    .values([
      {
        key: DASHBOARD_ACCESS_SETTING_KEY,
        value: {
          cloudEmailAccess: ["ada@example.com", "lin@example.com", "owner@example.com"],
          revision: 3,
        },
        updatedAt: now,
      },
      { key: "guardianName", value: "Olive", updatedAt: now },
    ])
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
          "agents:ep-atlas",
          "email:owner@example.com",
          "rome-cloud-email:owner@example.com",
          "slack:T1:U1",
          "telegram:42",
        ],
      },
      {
        name: null,
        avatarUrl: null,
        role: "member",
        accounts: ["email:ada@example.com", "rome-cloud-email:ada@example.com"],
      },
      {
        name: null,
        avatarUrl: null,
        role: "member",
        accounts: ["email:lin@example.com", "rome-cloud-email:lin@example.com"],
      },
    ]);

    const first = snapshot(db);
    await backfillMembers(db);
    expect(snapshot(db)).toEqual(first);
  });

  it("reads the invited emails again only under a higher revision than it read", async () => {
    testDb = createTestDb();
    const { db } = testDb;
    seed(db);
    await backfillMembers(db);

    db.update(settings)
      .set({ value: { cloudEmailAccess: ["lin@example.com"], revision: 3 } })
      .where(eq(settings.key, DASHBOARD_ACCESS_SETTING_KEY))
      .run();
    await backfillMembers(db);

    const ctx = memberContext(db);
    expect(
      await roleOfAccount(ctx, { platform: "rome-cloud-email", accountId: "ada@example.com" }),
    ).toBe("member");
  });

  it("makes the members the source of the invited emails once it has run", async () => {
    testDb = createTestDb();
    const { db } = testDb;
    seed(db);
    const store = new DashboardAccessStore(new SettingsRepository(db), db);
    expect(store.membersAreSource()).toBe(false);

    await backfillMembers(db);

    expect(store.membersAreSource()).toBe(true);
  });

  it("makes the members the source of the invited emails after a save", async () => {
    testDb = createTestDb();
    const { db } = testDb;
    const store = new DashboardAccessStore(new SettingsRepository(db), db);

    await store.save({ cloudEmailAccess: ["ada@example.com"] });

    expect(store.membersAreSource()).toBe(true);
  });

  it("changes nothing on members an older build already brought in line with the list", async () => {
    testDb = createTestDb();
    const { db } = testDb;
    seed(db);
    await backfillMembers(db);
    // An older build kept the members in line with the list but recorded no run.
    db.delete(settings).where(eq(settings.key, "backfill.membersFromInvitedEmails")).run();
    const before = snapshot(db);

    await backfillMembers(db);

    expect(snapshot(db)).toEqual(before);
  });

  it("keeps an email invited after the first run a member across a restart and a rollback, and a removed one removed", async () => {
    testDb = createTestDb();
    const { db } = testDb;
    seed(db);
    await backfillMembers(db);
    const store = new DashboardAccessStore(new SettingsRepository(db), db);
    const restart = async () => {
      await backfillMembers(db);
      const state = new DashboardAccessState();
      await state.load(db);
      return state;
    };

    await store.save({
      cloudEmailAccess: ["ada@example.com", "lin@example.com", "kim@example.com"],
    });
    let state = await restart();
    expect(state.isCloudEmailAllowed("kim@example.com")).toBe(true);
    expect(
      await roleOfAccount(memberContext(db), {
        platform: "rome-cloud-email",
        accountId: "kim@example.com",
      }),
    ).toBe("member");

    await store.save({ cloudEmailAccess: ["lin@example.com", "kim@example.com"] });
    state = await restart();
    expect(state.isCloudEmailAllowed("ada@example.com")).toBe(false);
    expect(
      await roleOfAccount(memberContext(db), {
        platform: "rome-cloud-email",
        accountId: "ada@example.com",
      }),
    ).toBeNull();
    expect([...state.cloudEmails()].sort()).toEqual(["kim@example.com", "lin@example.com"]);
    expect(state.isCloudEmailAllowed("owner@example.com")).toBe(true);

    // An older build after a rollback reads the record's list: the members
    // now, with the removed one gone and the invited one there.
    expect(
      normalizeDashboardAccessConfig(
        await new SettingsRepository(db).get(DASHBOARD_ACCESS_SETTING_KEY),
      ).cloudEmailAccess,
    ).toEqual(["kim@example.com", "lin@example.com"]);
  });

  it("reads the list again when an older build saved it after a rollback", async () => {
    testDb = createTestDb();
    const { db } = testDb;
    seed(db);
    await backfillMembers(db);
    const store = new DashboardAccessStore(new SettingsRepository(db), db);
    const { revision } = await store.save({
      cloudEmailAccess: ["ada@example.com", "lin@example.com"],
    });

    // Rolled back, the older build saves the list: it drops Ada, adds Kim and
    // raises the revision, and knows nothing of the members.
    db.update(settings)
      .set({
        value: { cloudEmailAccess: ["kim@example.com", "lin@example.com"], revision: revision + 1 },
      })
      .where(eq(settings.key, DASHBOARD_ACCESS_SETTING_KEY))
      .run();
    await backfillMembers(db);

    expect(await store.read()).toEqual({
      emails: ["kim@example.com", "lin@example.com"],
      revision: revision + 1,
    });
    expect(store.membersAreSource()).toBe(true);

    // A later startup with no older-build save since leaves a save alone.
    await store.save({ cloudEmailAccess: ["lin@example.com"] });
    await backfillMembers(db);
    expect((await store.read()).emails).toEqual(["lin@example.com"]);
  });

  it("reads no list for a raise at the next startup", async () => {
    testDb = createTestDb();
    const { db } = testDb;
    seed(db);
    await backfillMembers(db);
    const store = new DashboardAccessStore(new SettingsRepository(db), db);

    // Rome Cloud holds revision 10 after a restore of this database.
    expect(await store.raisePast(10)).toEqual({
      emails: ["ada@example.com", "lin@example.com"],
      revision: 11,
    });
    const before = snapshot(db);
    await backfillMembers(db);

    expect(snapshot(db)).toEqual(before);
    expect(await new SettingsRepository(db).get(DASHBOARD_ACCESS_SETTING_KEY)).toEqual({
      cloudEmailAccess: ["ada@example.com", "lin@example.com"],
      revision: 11,
      visitorAccounts: {},
    });
  });

  it("does not make the guardian's old email a member after a raise, a rebind and a restart", async () => {
    testDb = createTestDb();
    const { db } = testDb;
    // The older build's list holds the guardian's email.
    seed(db);
    await backfillMembers(db);
    const store = new DashboardAccessStore(new SettingsRepository(db), db);
    await store.raisePast(10);

    db.update(guardianAuth).set({ accountId: "acct-new", email: "new@example.com" }).run();
    const ctx = memberContext(db);
    await guardianSeatRebound(ctx, {
      previous: seatAccounts({ email: "owner@example.com" }),
      current: seatAccounts({ email: "new@example.com" }),
    });
    await backfillMembers(db);

    const owner = { platform: "rome-cloud-email", accountId: "owner@example.com" };
    expect(await roleOfAccount(ctx, owner)).toBeNull();
    expect(
      await roleOfAccount(ctx, { platform: "rome-cloud-email", accountId: "new@example.com" }),
    ).toBe("guardian");
  });

  it("still reads an older build's unread save after a raise", async () => {
    testDb = createTestDb();
    const { db } = testDb;
    seed(db);
    await backfillMembers(db);
    const store = new DashboardAccessStore(new SettingsRepository(db), db);

    // An older build saved the list after a rollback, and the startup after
    // it failed to read it.
    db.update(settings)
      .set({ value: { cloudEmailAccess: ["kim@example.com"], revision: 4 } })
      .where(eq(settings.key, DASHBOARD_ACCESS_SETTING_KEY))
      .run();
    await store.raisePast(10);
    await backfillMembers(db);

    expect(await store.read()).toEqual({ emails: ["kim@example.com"], revision: 11 });
  });

  it("keeps a member removed by a save made before its first run", async () => {
    testDb = createTestDb();
    const { db } = testDb;
    seed(db);
    const store = new DashboardAccessStore(new SettingsRepository(db), db);

    await store.save({ cloudEmailAccess: ["lin@example.com"] });
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

  it("names the guardian's person from the guardianName setting, with People's tables empty", async () => {
    testDb = createTestDb();
    const { db } = testDb;
    db.insert(guardianAuth)
      .values({ id: "seat", userId: "alex", passwordHash: "x", createdAt: now })
      .run();
    db.insert(settings).values({ key: "guardianName", value: "Alex Doe", updatedAt: now }).run();

    await backfillMembers(db);

    const [guardian] = await listMembers(memberContext(db));
    expect(guardian).toMatchObject({ role: "guardian", person: { name: "Alex Doe" } });
    expect(db.select().from(persons).all()).toEqual([]);
  });

  it("brings the guardian's name in Identity in line with the guardianName setting", async () => {
    testDb = createTestDb();
    const { db } = testDb;
    seed(db);
    // The name People keeps is not read.
    db.update(persons).set({ displayName: "Olivia" }).where(eq(persons.id, "p-owner")).run();
    await backfillMembers(db);
    // A local seat's person starts with the username.
    const [before] = await listMembers(memberContext(db));
    db.update(identities)
      .set({ name: "acct-owner" })
      .where(eq(identities.id, before.person.id))
      .run();

    await backfillMembers(db);

    const [guardian] = await listMembers(memberContext(db));
    expect(guardian.person).toMatchObject({ id: before.person.id, name: "Olive" });
  });

  it("leaves the guardian's name alone while no guardianName is set", async () => {
    testDb = createTestDb();
    const { db } = testDb;
    seed(db);
    db.delete(settings).where(eq(settings.key, "guardianName")).run();

    await backfillMembers(db);

    const [guardian] = await listMembers(memberContext(db));
    expect(guardian.person.name).toBeNull();
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
      "agents:ep-atlas",
      "email:new@example.com",
      "email:olive@example.com",
      "email:owner@example.com",
      "rome-cloud-email:new@example.com",
      "rome-cloud-email:owner@example.com",
      "slack:T1:U1",
      "telegram:42",
    ]);
  });

  it("gives each member's email account its sign-in, and a second run changes nothing", async () => {
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

    const member = (await listMembers(ctx)).find((m) => m.person.id === ada.id);
    expect(member).toEqual({
      person: { id: ada.id, name: null, avatarUrl: "https://example.com/ada.png" },
      role: "member",
      accounts: [
        { platform: "email", accountId: "ada@example.com" },
        { platform: "rome-cloud-email", accountId: "ada@example.com" },
      ],
    });
    const first = snapshot(db);
    await backfillMembers(db);
    expect(snapshot(db)).toEqual(first);
  });

  it("keeps the seat's address as the guardian's email account, whether People links it or not", async () => {
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
        "agents:ep-atlas",
        "email:owner@example.com",
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
