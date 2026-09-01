import { afterEach, describe, expect, it } from "@rstest/core";
import { checkGate, setFeatureGates, setGateOverride } from "./index.js";
import { useFakeFeatureGates, resetFeatureGates } from "./testing.js";

afterEach(() => resetFeatureGates());

describe("feature-flags registry", () => {
  it("fails closed (every gate false) when no backend is installed", async () => {
    await resetFeatureGates();
    expect(await checkGate("any_gate", "unit-1")).toBe(false);
  });

  it("delegates checkGate to the installed backend", async () => {
    setFeatureGates({ checkGate: async (gate) => gate === "on" });
    expect(await checkGate("on", "unit-1")).toBe(true);
    expect(await checkGate("off", "unit-1")).toBe(false);
  });

  it("passes the gate name and unit id through to the backend", async () => {
    const seen: Array<[string, string]> = [];
    setFeatureGates({
      checkGate: async (gate, unit) => {
        seen.push([gate, unit]);
        return true;
      },
    });
    await checkGate("my_gate", "tenant-9");
    expect(seen).toEqual([["my_gate", "tenant-9"]]);
  });
});

describe("setGateOverride", () => {
  it("forces an overridden gate, winning over the backend, and passes the rest through", async () => {
    setFeatureGates({ checkGate: async (gate) => gate === "backend_on" });
    setGateOverride("forced_on", true);
    setGateOverride("forced_off", false);
    expect(await checkGate("forced_on", "u")).toBe(true); // override beats a backend "false"
    expect(await checkGate("forced_off", "u")).toBe(false); // override beats a backend "true" too
    expect(await checkGate("backend_on", "u")).toBe(true); // non-overridden → backend decides
    expect(await checkGate("backend_off", "u")).toBe(false);
  });

  it("works over the all-off default backend (no Statsig wired)", async () => {
    await resetFeatureGates();
    setGateOverride("forced_on", true);
    expect(await checkGate("forced_on", "u")).toBe(true);
    expect(await checkGate("other", "u")).toBe(false);
  });

  it("survives a backend installed AFTER the override (order-independent)", async () => {
    // Regression: an override applied before initStatsig/setFeatureGates must
    // not be discarded when the backend installs.
    setGateOverride("forced_on", true);
    setFeatureGates({ checkGate: async () => false }); // a "real" backend lands later
    expect(await checkGate("forced_on", "u")).toBe(true); // override still wins
    expect(await checkGate("other", "u")).toBe(false);
  });

  it("clears a single override when passed undefined", async () => {
    setFeatureGates({ checkGate: async () => false });
    setGateOverride("g", true);
    expect(await checkGate("g", "u")).toBe(true);
    setGateOverride("g", undefined);
    expect(await checkGate("g", "u")).toBe(false); // back to the backend
  });
});

describe("useFakeFeatureGates", () => {
  it("enables a gate for a specific unit only", async () => {
    const gates = useFakeFeatureGates();
    gates.enable("g", "unit-a");
    expect(await checkGate("g", "unit-a")).toBe(true);
    expect(await checkGate("g", "unit-b")).toBe(false);
  });

  it("enables a gate for every unit when no unit is given", async () => {
    const gates = useFakeFeatureGates();
    gates.enable("g");
    expect(await checkGate("g", "anyone")).toBe(true);
    expect(await checkGate("other", "anyone")).toBe(false);
  });

  it("disables a previously enabled gate for a unit", async () => {
    const gates = useFakeFeatureGates();
    gates.enable("g");
    gates.disable("g", "unit-a");
    expect(await checkGate("g", "unit-a")).toBe(false);
    expect(await checkGate("g", "unit-b")).toBe(true);
  });

  it("breakBackend forces every gate closed", async () => {
    const gates = useFakeFeatureGates();
    gates.enable("g");
    gates.breakBackend();
    expect(await checkGate("g", "anyone")).toBe(false);
  });

  it("resetFeatureGates restores the default all-off backend", async () => {
    const gates = useFakeFeatureGates();
    gates.enable("g");
    await resetFeatureGates();
    expect(await checkGate("g", "anyone")).toBe(false);
  });
});
