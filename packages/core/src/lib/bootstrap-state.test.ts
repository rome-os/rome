/**
 * resolveBootstrapState — the server-side bootstrap FSM.
 * Pinned here as a pure function of (guardian row, env/instance inputs); the SPA
 * gate is a `switch (phase)` over its output, so this table is the contract.
 */
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { resolveBootstrapState, type BootstrapInputs } from "./bootstrap-state.js";
import { CLOUD_GUARDIAN_PASSWORD_SENTINEL } from "./guardian-auth-state.js";
import { guardianAuth } from "../db/schema.js";
import { createTestDb, type TestDb } from "../test/helpers.js";

let testDb: TestDb;

beforeEach(() => {
  testDb = createTestDb();
});
afterEach(() => {
  testDb.close();
});

function insertGuardian(
  opts: { onboardingComplete?: boolean; passwordHash?: string; accountId?: string | null } = {},
): void {
  testDb.db
    .insert(guardianAuth)
    .values({
      id: "g1",
      userId: "user-1",
      passwordHash: opts.passwordHash ?? "real-bcrypt-hash",
      accountId: opts.accountId ?? null,
      onboardingComplete: opts.onboardingComplete ?? false,
      createdAt: new Date(),
    })
    .run();
}

const CLOUD: BootstrapInputs = {
  cloudAuthEnabled: true,
  romeCloudConfigured: true,
  instanceEnrolled: true,
  hasSession: false,
};
const LOCAL: BootstrapInputs = {
  cloudAuthEnabled: false,
  romeCloudConfigured: true,
  instanceEnrolled: true,
  hasSession: false,
};

describe("resolveBootstrapState — cloud-default", () => {
  it("needs-signin (cloud) on a fresh box, with no local password to fall back to", async () => {
    const state = await resolveBootstrapState(testDb.db, { ...CLOUD, instanceEnrolled: false });
    expect(state).toEqual({
      phase: "needs-signin",
      method: "cloud",
      localPasswordAvailable: false,
    });
  });

  it("needs-signin (cloud) reports localPasswordAvailable=false for a cloud-only seat", async () => {
    insertGuardian({ passwordHash: CLOUD_GUARDIAN_PASSWORD_SENTINEL, accountId: "A" });
    const state = await resolveBootstrapState(testDb.db, CLOUD);
    expect(state).toEqual({
      phase: "needs-signin",
      method: "cloud",
      localPasswordAvailable: false,
    });
  });

  it("needs-signin (cloud) offers the local fallback when a real password exists", async () => {
    insertGuardian({ passwordHash: "real-bcrypt-hash", accountId: "A" });
    const state = await resolveBootstrapState(testDb.db, CLOUD);
    expect(state).toEqual({ phase: "needs-signin", method: "cloud", localPasswordAvailable: true });
  });

  it("threads dashboard visitor access through cloud sign-in state", async () => {
    insertGuardian({ passwordHash: "real-bcrypt-hash", accountId: "A" });
    const state = await resolveBootstrapState(testDb.db, {
      ...CLOUD,
      dashboardVisitorAccessEnabled: true,
    });
    expect(state).toEqual({
      phase: "needs-signin",
      method: "cloud",
      localPasswordAvailable: true,
      dashboardVisitorAccess: true,
    });
  });

  it("needs-onboarding once signed in but not onboarded", async () => {
    insertGuardian({ onboardingComplete: false, accountId: "A" });
    const state = await resolveBootstrapState(testDb.db, { ...CLOUD, hasSession: true });
    expect(state).toEqual({ phase: "needs-onboarding" });
  });

  it("ready once signed in and onboarded", async () => {
    insertGuardian({ onboardingComplete: true, accountId: "A" });
    const state = await resolveBootstrapState(testDb.db, { ...CLOUD, hasSession: true });
    expect(state).toEqual({ phase: "ready" });
  });

  it("needs-signin (cloud) for an onboarded cloud-only box whose session expired", async () => {
    insertGuardian({
      onboardingComplete: true,
      passwordHash: CLOUD_GUARDIAN_PASSWORD_SENTINEL,
      accountId: "A",
    });
    const state = await resolveBootstrapState(testDb.db, { ...CLOUD, hasSession: false });
    expect(state).toEqual({
      phase: "needs-signin",
      method: "cloud",
      localPasswordAvailable: false,
    });
  });
});

describe("resolveBootstrapState — local-first", () => {
  it("unenrolled when Rome Cloud is configured but the instance has no token", async () => {
    const state = await resolveBootstrapState(testDb.db, { ...LOCAL, instanceEnrolled: false });
    expect(state).toEqual({ phase: "unenrolled" });
  });

  it("needs-account when enrolled but no guardian seat exists", async () => {
    const state = await resolveBootstrapState(testDb.db, LOCAL);
    expect(state).toEqual({ phase: "needs-account" });
  });

  it("needs-signin (local) when the seat exists but there is no session", async () => {
    insertGuardian({ onboardingComplete: true });
    const state = await resolveBootstrapState(testDb.db, LOCAL);
    expect(state).toEqual({ phase: "needs-signin", method: "local" });
  });

  it("threads dashboard visitor access through local sign-in state", async () => {
    insertGuardian({ onboardingComplete: true });
    const state = await resolveBootstrapState(testDb.db, {
      ...LOCAL,
      dashboardVisitorAccessEnabled: true,
    });
    expect(state).toEqual({
      phase: "needs-signin",
      method: "local",
      dashboardVisitorAccess: true,
    });
  });

  it("needs-onboarding when signed in but not onboarded", async () => {
    insertGuardian({ onboardingComplete: false });
    const state = await resolveBootstrapState(testDb.db, { ...LOCAL, hasSession: true });
    expect(state).toEqual({ phase: "needs-onboarding" });
  });

  it("ready when signed in and onboarded", async () => {
    insertGuardian({ onboardingComplete: true });
    const state = await resolveBootstrapState(testDb.db, { ...LOCAL, hasSession: true });
    expect(state).toEqual({ phase: "ready" });
  });
});

describe("resolveBootstrapState — unconfigured (offline / self-hosted)", () => {
  it("skips the enroll gate and goes straight to local account setup", async () => {
    const state = await resolveBootstrapState(testDb.db, {
      cloudAuthEnabled: false,
      romeCloudConfigured: false,
      instanceEnrolled: false,
      hasSession: false,
    });
    expect(state).toEqual({ phase: "needs-account" });
  });
});
