import { describe, expect, it } from "@rstest/core";
import { PublicAccessState } from "./public-access-state.js";

describe("PublicAccessState", () => {
  it("starts empty", () => {
    const state = new PublicAccessState();
    expect(state.allowedApps().size).toBe(0);
    expect(state.cloudEmailApps().size).toBe(0);
  });

  it("setAllowedApps replaces the current allow-list", () => {
    const state = new PublicAccessState();
    state.setAllowedApps(["a", "b"]);
    expect([...state.allowedApps()].sort()).toEqual(["a", "b"]);

    state.setAllowedApps(["c"]);
    expect([...state.allowedApps()]).toEqual(["c"]);
  });

  it("setAllowedApps deduplicates", () => {
    const state = new PublicAccessState();
    state.setAllowedApps(["a", "a", "b"]);
    expect([...state.allowedApps()].sort()).toEqual(["a", "b"]);
  });

  it("returns a Set whose mutations are isolated from later updates", () => {
    const state = new PublicAccessState();
    state.setAllowedApps(["a"]);
    const snapshot = state.allowedApps();
    state.setAllowedApps(["b"]);
    expect([...snapshot]).toEqual(["a"]);
  });

  it("stores cloud-email app allow-lists", () => {
    const state = new PublicAccessState();
    state.setCloudEmailAccess({ app: ["a@example.com", "b@example.com"] });
    expect([...state.cloudEmailApps()]).toEqual(["app"]);
    expect([...state.cloudEmailsForApp("app")].sort()).toEqual(["a@example.com", "b@example.com"]);
    expect(state.isCloudEmailApp("app")).toBe(true);
  });
});
