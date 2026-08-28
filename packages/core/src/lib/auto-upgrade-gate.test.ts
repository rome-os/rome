import { afterEach, describe, expect, it } from "@rstest/core";
import type { Config } from "../config.js";
import { AUTO_UPGRADE_GATE_NAME, resolveAutoUpgradeEnabled } from "./auto-upgrade-gate.js";
import { useFakeFeatureGates, resetFeatureGates } from "@rome-os/libs/feature-flags/testing";

function configWithSlug(instanceSlug?: string): Config {
  // Only the field the resolver reads matters here.
  return { instanceSlug } as Config;
}

afterEach(async () => {
  await resetFeatureGates();
});

describe("resolveAutoUpgradeEnabled", () => {
  it("fails closed when the instance has no slug", async () => {
    const gates = useFakeFeatureGates();
    gates.enable(AUTO_UPGRADE_GATE_NAME); // on for everyone…
    // …but no slug means no rollout key, so it still resolves false.
    expect(await resolveAutoUpgradeEnabled(configWithSlug(undefined))).toBe(false);
  });

  it("is enabled when the gate passes for the instance slug", async () => {
    const gates = useFakeFeatureGates();
    gates.enable(AUTO_UPGRADE_GATE_NAME, "inst-42");
    expect(await resolveAutoUpgradeEnabled(configWithSlug("inst-42"))).toBe(true);
  });

  it("is disabled when the gate is off for the slug", async () => {
    useFakeFeatureGates();
    expect(await resolveAutoUpgradeEnabled(configWithSlug("inst-42"))).toBe(false);
  });

  it("fails closed when the backend is unreachable", async () => {
    const gates = useFakeFeatureGates();
    gates.enable(AUTO_UPGRADE_GATE_NAME, "inst-42");
    gates.breakBackend();
    expect(await resolveAutoUpgradeEnabled(configWithSlug("inst-42"))).toBe(false);
  });
});
