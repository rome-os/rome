import { describe, expect, it } from "@rstest/core";
import { LIVE_READ_GAP_MS, withNextStep } from "./connection-pointer.js";

const working = {
  id: "dev-1:apple_health",
  kind: "apple_health",
  title: "Apple Health",
  device: { id: "dev-1", name: "iPhone" },
  state: "working" as const,
  lastSeenAt: "2026-11-14T10:00:00.000Z",
};

describe("the next step on a working connection", () => {
  it("answers a gap of minutes from the store, with no live read and no later check", () => {
    const { next } = withNextStep(working, 20 * 60 * 1000);
    expect(next).toContain("under an hour behind");
    expect(next).not.toContain("rome-node device run");
    expect(next).toContain("schedule no later check");
  });

  it("reads a wider gap live now", () => {
    const { next } = withNextStep(working, LIVE_READ_GAP_MS + 1);
    expect(next).toContain("rome-node device run dev-1 <action>");
    expect(next).toContain("Do not schedule a later check");
  });
});
