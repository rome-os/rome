import { afterEach, describe, expect, it } from "@rstest/core";
import { checkGate, setFeatureGates } from "./index.js";
import { parseGateOverrides, installEnvGateOverrides } from "./env-overrides.js";
import { resetFeatureGates } from "./testing.js";

afterEach(() => resetFeatureGates());

describe("parseGateOverrides", () => {
  it("maps FEATURE_GATE_<NAME> to a lowercased gate name and boolean", () => {
    const out = parseGateOverrides({
      FEATURE_GATE_ROME_CLOUD_AUTH: "on",
      FEATURE_GATE_SOME_FLAG: "off",
      UNRELATED: "on",
      PANTHEON_SLUG: "s",
    });
    expect([...out.entries()]).toEqual([
      ["rome_cloud_auth", true],
      ["some_flag", false],
    ]);
  });

  it("accepts every recognized truthy/falsey token, case-insensitively", () => {
    for (const t of ["1", "true", "YES", "On"]) {
      expect(parseGateOverrides({ FEATURE_GATE_G: t }).get("g")).toBe(true);
    }
    for (const t of ["0", "false", "NO", "Off"]) {
      expect(parseGateOverrides({ FEATURE_GATE_G: t }).get("g")).toBe(false);
    }
  });

  it("skips blank/whitespace values (no override) and the bare prefix", () => {
    const out = parseGateOverrides({
      FEATURE_GATE_G: "",
      FEATURE_GATE_H: "   ",
      FEATURE_GATE_: "on",
    });
    expect(out.size).toBe(0);
  });

  it("throws on an unrecognized token rather than silently coercing", () => {
    expect(() => parseGateOverrides({ FEATURE_GATE_G: "tru" })).toThrow(/Invalid FEATURE_GATE_G/);
  });
});

describe("installEnvGateOverrides", () => {
  it("forces gates over the active backend and returns the applied names", async () => {
    setFeatureGates({ checkGate: async () => false }); // backend says everything off
    const applied = installEnvGateOverrides({ FEATURE_GATE_ROME_CLOUD_AUTH: "on" });
    expect(applied).toEqual(["rome_cloud_auth"]);
    expect(await checkGate("rome_cloud_auth", "any-slug")).toBe(true);
    expect(await checkGate("other", "any-slug")).toBe(false);
  });

  it("applies with no backend wired (all-off default) and is a no-op when none are set", async () => {
    await resetFeatureGates();
    expect(installEnvGateOverrides({ NOTHING: "on" })).toEqual([]);
    expect(await checkGate("rome_cloud_auth", "s")).toBe(false);
    installEnvGateOverrides({ FEATURE_GATE_ROME_CLOUD_AUTH: "1" });
    expect(await checkGate("rome_cloud_auth", "s")).toBe(true);
  });
});
