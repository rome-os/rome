import { describe, it, expect, beforeEach, afterEach } from "@rstest/core";
import { resolveCloudAuthEnabled, CLOUD_AUTH_GATE_NAME } from "./cloud-auth-gate.js";
import { CLOUD_GUARDIAN_PASSWORD_SENTINEL } from "./guardian-auth-state.js";
import { useFakeFeatureGates, resetFeatureGates } from "@rome-os/libs/feature-flags/testing";
import { guardianAuth } from "../db/schema.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import type { Config } from "../config.js";

/**
 * The resolver reads `instanceSlug` (the gate's rollout unit) and the guardian
 * seat (for stickiness), so a partial config plus a real test DB is enough. The
 * gate backend is the process-global one — faked here via the offline-Statsig
 * testing helper.
 */
function config(partial: Partial<Config>): Config {
  return partial as Config;
}

let testDb: TestDb;

beforeEach(() => {
  testDb = createTestDb();
});
afterEach(async () => {
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
    expect(await resolveCloudAuthEnabled(config({ instanceSlug: "s" }), testDb.db)).toBe(false);
    gates.enable(CLOUD_AUTH_GATE_NAME, "s");
    expect(await resolveCloudAuthEnabled(config({ instanceSlug: "s" }), testDb.db)).toBe(true);
  });

  it("keys the gate on the instance slug", async () => {
    const gates = useFakeFeatureGates();
    gates.enable(CLOUD_AUTH_GATE_NAME, "prod-tenant-7");
    expect(
      await resolveCloudAuthEnabled(config({ instanceSlug: "prod-tenant-7" }), testDb.db),
    ).toBe(true);
    expect(await resolveCloudAuthEnabled(config({ instanceSlug: "other-box" }), testDb.db)).toBe(
      false,
    );
  });

  it("fails closed when there is no slug and no cloud-only seat", async () => {
    const gates = useFakeFeatureGates();
    gates.enable(CLOUD_AUTH_GATE_NAME);
    expect(await resolveCloudAuthEnabled(config({ instanceSlug: undefined }), testDb.db)).toBe(
      false,
    );
  });

  it("fails closed when the gate backend is unreachable and there is no cloud-only seat", async () => {
    const gates = useFakeFeatureGates();
    gates.enable(CLOUD_AUTH_GATE_NAME, "s");
    gates.breakBackend();
    expect(await resolveCloudAuthEnabled(config({ instanceSlug: "s" }), testDb.db)).toBe(false);
  });

  describe("sticky cloud (a cloud-only guardian seat exists)", () => {
    beforeEach(() => insertGuardian(CLOUD_GUARDIAN_PASSWORD_SENTINEL));

    it("stays on even when the gate is off, so the guardian is never stranded", async () => {
      useFakeFeatureGates(); // gate not enabled → would otherwise be false
      expect(await resolveCloudAuthEnabled(config({ instanceSlug: "s" }), testDb.db)).toBe(true);
    });

    it("stays on when the backend is unreachable", async () => {
      const gates = useFakeFeatureGates();
      gates.breakBackend();
      expect(await resolveCloudAuthEnabled(config({ instanceSlug: "s" }), testDb.db)).toBe(true);
    });

    it("stays on even without a slug to key the gate on", async () => {
      useFakeFeatureGates();
      expect(await resolveCloudAuthEnabled(config({ instanceSlug: undefined }), testDb.db)).toBe(
        true,
      );
    });
  });

  it("is not sticky for a local guardian seat (has a real password): the gate decides", async () => {
    const gates = useFakeFeatureGates();
    insertGuardian("real-bcrypt-hash");
    expect(await resolveCloudAuthEnabled(config({ instanceSlug: "s" }), testDb.db)).toBe(false);
    gates.enable(CLOUD_AUTH_GATE_NAME, "s");
    expect(await resolveCloudAuthEnabled(config({ instanceSlug: "s" }), testDb.db)).toBe(true);
  });
});
