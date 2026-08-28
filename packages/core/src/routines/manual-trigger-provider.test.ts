import { describe, it, expect, beforeEach } from "@rstest/core";
import { ManualTriggerProvider } from "./manual-trigger-provider.js";
import type { Routine, Trigger } from "./types.js";

function buildRoutine(overrides: Partial<Routine> & { trigger: Trigger }): Routine {
  return {
    id: overrides.id ?? "r-1",
    name: overrides.name ?? "test",
    enabled: overrides.enabled ?? true,
    trigger: overrides.trigger,
    actionName: overrides.actionName ?? "noop",
    args: overrides.args ?? {},
    createdAt: overrides.createdAt ?? new Date(),
  };
}

describe("ManualTriggerProvider", () => {
  let provider: ManualTriggerProvider;

  beforeEach(() => {
    provider = new ManualTriggerProvider();
  });

  it("marks the routine active on activate but never calls fire", async () => {
    let fireCount = 0;
    await provider.activate(buildRoutine({ id: "r-1", trigger: { type: "manual" } }), async () => {
      fireCount++;
    });

    expect(provider.isActive("r-1")).toBe(true);
    // There is no condition to watch: the callback is never invoked on its own.
    expect(fireCount).toBe(0);
  });

  it("clears the routine on deactivate", async () => {
    await provider.activate(
      buildRoutine({ id: "r-1", trigger: { type: "manual" } }),
      async () => {},
    );
    provider.deactivate("r-1");
    expect(provider.isActive("r-1")).toBe(false);
  });

  it("reports inactive for an unknown routine", () => {
    expect(provider.isActive("nope")).toBe(false);
  });

  it("stop() clears all active routines", async () => {
    await provider.activate(
      buildRoutine({ id: "r-1", trigger: { type: "manual" } }),
      async () => {},
    );
    await provider.activate(
      buildRoutine({ id: "r-2", trigger: { type: "manual" } }),
      async () => {},
    );
    provider.stop();
    expect(provider.isActive("r-1")).toBe(false);
    expect(provider.isActive("r-2")).toBe(false);
  });
});
