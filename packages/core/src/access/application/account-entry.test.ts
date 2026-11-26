import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { sql } from "drizzle-orm";
import { guardianAuth } from "../../db/schema.js";
import { createTestDb, type TestDb } from "../../test/db.js";
import { startedActingForGuardian } from "../acts-for-guardian.js";
import { VisitorProfilesRepository } from "../visitor-profiles.js";
import { accountEntry } from "./account-entry.js";
import { guardianSeatCreated, inviteMember, memberContext, removeMember } from "./members.js";

const OWNER = { platform: "slack", id: "T1:U0" };
const ADA = { platform: "slack", id: "T1:U2" };
const GUARDIAN = { kind: "guardian", userId: "owner", via: "loopback" } as const;

describe("accountEntry", () => {
  let testDb: TestDb;
  beforeEach(async () => {
    testDb = createTestDb();
    const ctx = memberContext(testDb.db);
    await testDb.db
      .insert(guardianAuth)
      .values({ id: "seat", userId: "owner", passwordHash: "", createdAt: new Date() });
    await guardianSeatCreated(ctx, {
      accounts: [{ platform: OWNER.platform, accountId: OWNER.id }],
    });
    const ada = await inviteMember(ctx, "ada@example.com");
    await ctx.identity.addAccount(ada.id, { platform: ADA.platform, accountId: ADA.id });
  });
  afterEach(() => testDb.close());

  const enter = (account: { platform: string; id: string }) =>
    accountEntry({ db: testDb.db })(account);

  it("lets in the guardian as their seat", async () => {
    expect(await enter(OWNER)).toEqual({ kind: "entered", person: GUARDIAN });
  });

  it("lets in a member as their sign-in, and refuses one whose sign-in it cannot find", async () => {
    expect(await enter(ADA)).toEqual({ kind: "refused" });
    await new VisitorProfilesRepository(testDb.db).record("cloud-ada", {
      email: "Ada@Example.com",
      avatarUrl: null,
    });
    expect(await enter(ADA)).toEqual({
      kind: "entered",
      person: { kind: "visitor", accountId: "cloud-ada", email: "ada@example.com" },
    });
  });

  it("stops letting in a member who was removed", async () => {
    await removeMember(memberContext(testDb.db), "ada@example.com");
    expect(await enter(ADA)).toEqual({ kind: "unknown" });
  });

  it("lets in an account that acts for the guardian, as the guardian", async () => {
    const agent = { platform: "agents", id: "dot" };
    expect(await enter(agent)).toEqual({ kind: "unknown" });
    startedActingForGuardian(testDb.db, agent);
    expect(await enter(agent)).toEqual({ kind: "entered", person: GUARDIAN });
  });

  it("refuses an account whose person has no role", async () => {
    const { identity } = memberContext(testDb.db);
    await identity.createPerson({ accounts: [{ platform: "slack", accountId: "T1:U8" }] });
    expect(await enter({ platform: "slack", id: "T1:U8" })).toEqual({ kind: "refused" });
  });

  it("knows nobody by an account no person holds", async () => {
    expect(await enter({ platform: "slack", id: "T1:U9" })).toEqual({ kind: "unknown" });
    // The address of a sign-in, seen as the sender of a message.
    expect(await enter({ platform: "email", id: "ada@example.com" })).toEqual({ kind: "unknown" });
  });

  it("refuses an account no one named or verified", async () => {
    const { identity } = memberContext(testDb.db);
    const owner = await identity.personOf({ platform: OWNER.platform, accountId: OWNER.id });
    await identity.addAccount(owner?.id ?? "", {
      platform: "email",
      accountId: "unauthenticated:owner@example.com",
    });
    for (const account of [
      { platform: "email", id: "unauthenticated:owner@example.com" },
      { platform: "email", id: " Unauthenticated:Owner@example.com" },
      { platform: "slack", id: " " },
      { platform: "", id: OWNER.id },
    ]) {
      expect(await enter(account)).toEqual({ kind: "refused" });
    }
  });

  it("refuses when no answer can be had", async () => {
    testDb.db.run(sql`DROP TABLE accounts_acting_for_guardian`);
    expect(await enter({ platform: "slack", id: "T1:U9" })).toEqual({ kind: "refused" });
  });
});
