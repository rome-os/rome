import { describe, expect, it } from "@rstest/core";
import {
  isPersonalAction,
  knownNotPersonal,
  personalDataRefusal,
  turnIsShared,
} from "./audience.js";

const info = (capabilities: unknown) => ({
  type: "response" as const,
  ok: true as const,
  result: { name: "iPhone", platform: "ios", capabilities },
});

describe("turn audience guard", () => {
  it("checks only when the session says the turn is not private", () => {
    expect(turnIsShared({})).toBe(false);
    expect(turnIsShared({ ROME_TURN_AUDIENCE: "private" })).toBe(false);
    expect(turnIsShared({ ROME_TURN_AUDIENCE: "shared" })).toBe(true);
    // An unknown value fails closed.
    expect(turnIsShared({ ROME_TURN_AUDIENCE: "" })).toBe(true);
  });

  it("treats Health as personal on any device, even one that reports no capabilities", () => {
    expect(isPersonalAction("health.stats", undefined)).toBe(true);
    expect(isPersonalAction("health.samples", info(undefined))).toBe(true);
  });

  it("reads the personal mark of the capability the action's prefix names", () => {
    const described = info([
      { prefix: "calendar", personal: true },
      { prefix: "device", personal: false },
    ]);
    expect(isPersonalAction("calendar.events", described)).toBe(true);
    expect(isPersonalAction("device.status", described)).toBe(false);
    expect(isPersonalAction("photos.list", described)).toBe(false);
  });

  it("lets a computer's own actions through without asking the device", () => {
    expect(knownNotPersonal("exec")).toBe(true);
    expect(knownNotPersonal("fs.list")).toBe(true);
    expect(knownNotPersonal("health.stats")).toBe(false);
  });

  it("refuses with a code the agent can read", () => {
    const refusal = personalDataRefusal();
    expect(refusal.ok).toBe(false);
    if (!refusal.ok) expect(refusal.error.code).toBe("personal_data_private_only");
  });
});
