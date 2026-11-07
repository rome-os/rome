import { afterEach, describe, expect, it } from "@rstest/core";
import { AUTO_UPGRADE_GATE_NAME, resolveAutoUpgradeEnabled } from "./auto-upgrade-gate.js";
import { useFakeFeatureGates, resetFeatureGates } from "@rome-os/libs/feature-flags/testing";

const originalSlug = process.env.PANTHEON_SLUG;

function resolveFor(slug: string | undefined): Promise<boolean> {
  if (slug === undefined) delete process.env.PANTHEON_SLUG;
  else process.env.PANTHEON_SLUG = slug;
  return resolveAutoUpgradeEnabled();
}

afterEach(async () => {
  if (originalSlug === undefined) delete process.env.PANTHEON_SLUG;
  else process.env.PANTHEON_SLUG = originalSlug;
  await resetFeatureGates();
});

describe("resolveAutoUpgradeEnabled", () => {
  it("fails closed when the instance has no slug", async () => {
    const gates = useFakeFeatureGates();
    gates.enable(AUTO_UPGRADE_GATE_NAME); // on for everyone…
    // …but no slug means no rollout key, so it still resolves false.
    expect(await resolveFor(undefined)).toBe(false);
  });

  it("is enabled when the gate passes for the instance slug", async () => {
    const gates = useFakeFeatureGates();
    gates.enable(AUTO_UPGRADE_GATE_NAME, "inst-42");
    expect(await resolveFor("inst-42")).toBe(true);
  });

  it("is disabled when the gate is off for the slug", async () => {
    useFakeFeatureGates();
    expect(await resolveFor("inst-42")).toBe(false);
  });

  it("reads the slug live, not from a boot-time snapshot", async () => {
    const gates = useFakeFeatureGates();
    gates.enable(AUTO_UPGRADE_GATE_NAME, "adopted-tenant");
    expect(await resolveFor("pool-slug")).toBe(false);
    expect(await resolveFor("adopted-tenant")).toBe(true);
  });

  it("fails closed when the backend is unreachable", async () => {
    const gates = useFakeFeatureGates();
    gates.enable(AUTO_UPGRADE_GATE_NAME, "inst-42");
    gates.breakBackend();
    expect(await resolveFor("inst-42")).toBe(false);
  });
});
