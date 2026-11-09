import { describe, it, expect, beforeEach, afterEach } from "@rstest/core";
import { resolveCloudAuthEnabled, CLOUD_AUTH_GATE_NAME } from "./cloud-auth-gate.js";
import { CLOUD_GUARDIAN_PASSWORD_SENTINEL } from "./guardian-auth-state.js";
import { useFakeFeatureGates, resetFeatureGates } from "@rome-os/libs/feature-flags/testing";
import { guardianAuth } from "../db/schema.js";
import { createTestDb, type TestDb } from "../test/db.js";

/**
 * The resolver reads the instance slug (the gate's rollout unit) live from the
 * environment and the guardian seat (for stickiness) from a real test DB. The
 * gate backend is the process-global one — faked here via the offline-Statsig
 * testing helper.
 */
function resolveFor(slug: string | undefined): Promise<boolean> {
  if (slug === undefined) delete process.env.PANTHEON_SLUG;
  else process.env.PANTHEON_SLUG = slug;
  return resolveCloudAuthEnabled(testDb.db);
}

let testDb: TestDb;
const originalSlug = process.env.PANTHEON_SLUG;

beforeEach(() => {
  testDb = createTestDb();
});
afterEach(async () => {
  if (originalSlug === undefined) delete process.env.PANTHEON_SLUG;
  else process.env.PANTHEON_SLUG = originalSlug;
  await resetFeatureGates();
  testDb.close();
});

/** Seed a guardian seat. A cloud seat carries the sentinel (no local password). */
function insertGuardian(passwordHash: string): void {
  testDb.db
    .insert(guardianAuth)
    .values({
      id: "g1",
      userId: "user-1",
      passwordHash,
      accountId: "acct-1",
      onboardingComplete: true,
      createdAt: new Date(),
    })
    .run();
}

describe("resolveCloudAuthEnabled", () => {
  it("returns the gate decision when there is no cloud-only seat", async () => {
    const gates = useFakeFeatureGates();
    expect(await resolveFor("s")).toBe(false);
    gates.enable(CLOUD_AUTH_GATE_NAME, "s");
    expect(await resolveFor("s")).toBe(true);
  });

  it("keys the gate on the instance slug", async () => {
    const gates = useFakeFeatureGates();
    gates.enable(CLOUD_AUTH_GATE_NAME, "prod-tenant-7");
    expect(await resolveFor("prod-tenant-7")).toBe(true);
    expect(await resolveFor("other-box")).toBe(false);
  });

  it("reads the slug live, not from a boot-time snapshot", async () => {
    const gates = useFakeFeatureGates();
    gates.enable(CLOUD_AUTH_GATE_NAME, "adopted-tenant");
    expect(await resolveFor("pool-slug")).toBe(false);
    expect(await resolveFor("adopted-tenant")).toBe(true);
  });

  it("fails closed when there is no slug and no cloud-only seat", async () => {
    const gates = useFakeFeatureGates();
    gates.enable(CLOUD_AUTH_GATE_NAME);
    expect(await resolveFor(undefined)).toBe(false);
  });

  it("fails closed when the gate backend is unreachable and there is no cloud-only seat", async () => {
    const gates = useFakeFeatureGates();
    gates.enable(CLOUD_AUTH_GATE_NAME, "s");
    gates.breakBackend();
    expect(await resolveFor("s")).toBe(false);
  });

  describe("sticky cloud (a cloud-only guardian seat exists)", () => {
    beforeEach(() => insertGuardian(CLOUD_GUARDIAN_PASSWORD_SENTINEL));

    it("stays on even when the gate is off, so the guardian is never stranded", async () => {
      useFakeFeatureGates(); // gate not enabled → would otherwise be false
      expect(await resolveFor("s")).toBe(true);
    });

    it("stays on when the backend is unreachable", async () => {
      const gates = useFakeFeatureGates();
      gates.breakBackend();
      expect(await resolveFor("s")).toBe(true);
    });

    it("stays on even without a slug to key the gate on", async () => {
      useFakeFeatureGates();
      expect(await resolveFor(undefined)).toBe(true);
    });
  });

  it("is not sticky for a local guardian seat (has a real password): the gate decides", async () => {
    const gates = useFakeFeatureGates();
    insertGuardian("real-bcrypt-hash");
    expect(await resolveFor("s")).toBe(false);
    gates.enable(CLOUD_AUTH_GATE_NAME, "s");
    expect(await resolveFor("s")).toBe(true);
  });
});
