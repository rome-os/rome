import { describe, expect, it } from "@rstest/core";
import { normalizeAppPermissionsSetting } from "./app-permissions.js";

// A policy persisted by an earlier release can still carry the retired
// `enableAccessControl` flag. It is dropped on read.
describe("normalizeAppPermissionsSetting with a persisted legacy enableAccessControl flag", () => {
  it("normalizes without the flag and keeps the app policy", () => {
    const config = normalizeAppPermissionsSetting({
      enableAccessControl: true,
      allowedApps: ["morning-brief"],
      cloudEmailAccess: { "night-brief": ["a@b.co"] },
    });
    expect(config).toEqual({
      allowedApps: ["morning-brief"],
      cloudEmailAccess: { "night-brief": ["a@b.co"] },
    });
    expect("enableAccessControl" in config).toBe(false);
  });
});
