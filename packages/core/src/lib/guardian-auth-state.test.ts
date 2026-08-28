import { describe, it, expect, afterEach, beforeEach, rs } from "@rstest/core";
import { eq } from "drizzle-orm";
import {
  CLOUD_GUARDIAN_PASSWORD_SENTINEL,
  getGuardianAuthState,
  resolveAndRecordAccount,
  setGuardianAccount,
} from "./guardian-auth-state.js";
import type { ProveIdentityResult } from "./instance-identity.js";
import { guardianAuth } from "../db/schema.js";
import { createTestDb, type TestDb } from "../test/helpers.js";

describe("getGuardianAuthState", () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => {
    testDb.close();
  });

  it("returns an absent state when no guardian row exists", async () => {
    const out = await getGuardianAuthState(testDb.db);
    expect(out).toEqual({
      exists: false,
      onboardingComplete: false,
      userId: null,
      accountId: null,
      hasLocalPassword: false,
    });
  });

  it("surfaces the userId and onboarding flag when a row is present", async () => {
    await testDb.db.insert(guardianAuth).values({
      id: "g1",
      userId: "user-1",
      passwordHash: "hash",
      onboardingComplete: true,
      createdAt: new Date(),
    });
    const out = await getGuardianAuthState(testDb.db);
    expect(out).toEqual({
      exists: true,
      onboardingComplete: true,
      userId: "user-1",
      accountId: null,
      hasLocalPassword: true,
    });
  });

  it("returns onboardingComplete=false when the stored flag is false", async () => {
    await testDb.db.insert(guardianAuth).values({
      id: "g1",
      userId: "user-1",
      passwordHash: "hash",
      onboardingComplete: false,
      createdAt: new Date(),
    });
    const out = await getGuardianAuthState(testDb.db);
    expect(out).toEqual({
      exists: true,
      onboardingComplete: false,
      userId: "user-1",
      accountId: null,
      hasLocalPassword: true,
    });
  });

  it("reports hasLocalPassword=false for a cloud-only seat (sentinel hash)", async () => {
    await testDb.db.insert(guardianAuth).values({
      id: "g1",
      userId: "acct-A",
      passwordHash: CLOUD_GUARDIAN_PASSWORD_SENTINEL,
      accountId: "acct-A",
      createdAt: new Date(),
    });
    const out = await getGuardianAuthState(testDb.db);
    expect(out.hasLocalPassword).toBe(false);
  });

  it("surfaces the recorded accountId when the seat is cloud-bound", async () => {
    await testDb.db.insert(guardianAuth).values({
      id: "g1",
      userId: "user-1",
      passwordHash: "hash",
      accountId: "acct-A",
      createdAt: new Date(),
    });
    const out = await getGuardianAuthState(testDb.db);
    expect(out.accountId).toBe("acct-A");
  });
});

describe("resolveAndRecordAccount", () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => {
    testDb.close();
    rs.restoreAllMocks();
  });

  const seedGuardian = (accountId: string | null) =>
    testDb.db.insert(guardianAuth).values({
      id: "g1",
      userId: "user-1",
      passwordHash: "hash",
      accountId,
      createdAt: new Date(),
    });

  const provesAs = (result: ProveIdentityResult) => async (): Promise<ProveIdentityResult> =>
    result;

  const ok = (
    accountId: string,
    profile: { email?: string; avatarUrl?: string | null } = {},
  ): ProveIdentityResult => ({
    status: "ok",
    identity: { accountId, instanceId: "inst-1", ...profile },
  });

  const readAccountId = async (): Promise<string | null> => {
    const [row] = await testDb.db
      .select({ accountId: guardianAuth.accountId })
      .from(guardianAuth)
      .where(eq(guardianAuth.id, "g1"));
    return row?.accountId ?? null;
  };

  it("records the bound account when accountId is null", async () => {
    await seedGuardian(null);
    await resolveAndRecordAccount(testDb.db, { prove: provesAs(ok("acct-A")) });
    expect(await readAccountId()).toBe("acct-A");
  });

  it("caches profile fields while recording or refreshing the matching account", async () => {
    await seedGuardian(null);
    await resolveAndRecordAccount(testDb.db, {
      prove: provesAs(
        ok("acct-A", {
          email: "owner@example.com",
          avatarUrl: "https://example.com/avatar.png",
        }),
      ),
    });

    await resolveAndRecordAccount(testDb.db, {
      prove: provesAs(ok("acct-A", { avatarUrl: "https://example.com/new-avatar.png" })),
    });

    const [row] = await testDb.db
      .select({ email: guardianAuth.email, avatarUrl: guardianAuth.avatarUrl })
      .from(guardianAuth)
      .where(eq(guardianAuth.id, "g1"));
    expect(row).toEqual({
      email: "owner@example.com",
      avatarUrl: "https://example.com/new-avatar.png",
    });
  });

  it("logs a would-reject mismatch and leaves the recorded account intact", async () => {
    await seedGuardian("acct-A");
    const warn = rs.spyOn(console, "warn").mockImplementation(() => {});

    await resolveAndRecordAccount(testDb.db, { prove: provesAs(ok("acct-B")) });

    expect(await readAccountId()).toBe("acct-A");
    const warnings = warn.mock.calls.map(([line]) => String(line));
    expect(warnings.some((line) => line.includes("account mismatch (would reject)"))).toBe(true);
    expect(warnings.some((line) => line.includes("acct-A") && line.includes("acct-B"))).toBe(true);
  });

  it("is a no-op when accountId already matches the resolved account", async () => {
    await seedGuardian("acct-A");
    const warn = rs.spyOn(console, "warn").mockImplementation(() => {});

    await resolveAndRecordAccount(testDb.db, { prove: provesAs(ok("acct-A")) });

    expect(await readAccountId()).toBe("acct-A");
    const warnings = warn.mock.calls.map(([line]) => String(line));
    expect(warnings.some((line) => line.includes("account mismatch"))).toBe(false);
  });

  it("leaves accountId unchanged when Rome Cloud is unreachable", async () => {
    await seedGuardian(null);
    await resolveAndRecordAccount(testDb.db, { prove: provesAs({ status: "unreachable" }) });
    expect(await readAccountId()).toBeNull();
  });

  it("is a silent no-op when no guardian seat exists yet", async () => {
    await expect(
      resolveAndRecordAccount(testDb.db, { prove: provesAs(ok("acct-A")) }),
    ).resolves.toBeUndefined();
  });
});

describe("setGuardianAccount", () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => {
    testDb.close();
  });

  const seedGuardian = (
    accountId: string | null,
    email: string | null = null,
    avatarUrl: string | null = null,
  ) =>
    testDb.db.insert(guardianAuth).values({
      id: "g1",
      userId: "user-1",
      passwordHash: "hash",
      accountId,
      email,
      avatarUrl,
      createdAt: new Date(),
    });

  const readRow = async () => {
    const [row] = await testDb.db
      .select({
        accountId: guardianAuth.accountId,
        email: guardianAuth.email,
        avatarUrl: guardianAuth.avatarUrl,
      })
      .from(guardianAuth)
      .where(eq(guardianAuth.id, "g1"));
    return row ?? null;
  };

  it("stamps the account and email on the seat", async () => {
    await seedGuardian(null);
    await setGuardianAccount(
      testDb.db,
      "acct-A",
      "a@example.com",
      "https://example.com/avatar.png",
    );
    expect(await readRow()).toEqual({
      accountId: "acct-A",
      email: "a@example.com",
      avatarUrl: "https://example.com/avatar.png",
    });
  });

  it("keeps the recorded email when the same account re-authenticates without an email claim", async () => {
    await seedGuardian("acct-A", "a@example.com", "https://example.com/avatar.png");
    await setGuardianAccount(testDb.db, "acct-A");
    expect(await readRow()).toEqual({
      accountId: "acct-A",
      email: "a@example.com",
      avatarUrl: "https://example.com/avatar.png",
    });
  });

  it("clears the stale email when rebinding to a different account without an email claim", async () => {
    await seedGuardian("acct-old", "old@example.com", "https://example.com/old-avatar.png");
    await setGuardianAccount(testDb.db, "acct-new");
    expect(await readRow()).toEqual({ accountId: "acct-new", email: null, avatarUrl: null });
  });

  it("replaces the email when rebinding to a different account with a new claim", async () => {
    await seedGuardian("acct-old", "old@example.com", "https://example.com/old-avatar.png");
    await setGuardianAccount(
      testDb.db,
      "acct-new",
      "new@example.com",
      "https://example.com/new-avatar.png",
    );
    expect(await readRow()).toEqual({
      accountId: "acct-new",
      email: "new@example.com",
      avatarUrl: "https://example.com/new-avatar.png",
    });
  });
});
