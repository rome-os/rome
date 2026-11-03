import { describe, expect, it } from "@rstest/core";
import { resolveSessionPolicy } from "./session-policy.js";

describe("resolveSessionPolicy", () => {
  it("keeps today's chat behavior by default, with memory for main only", () => {
    expect(resolveSessionPolicy({ name: "main" })).toEqual({
      finalText: "deliver",
      autoTitle: true,
      loadMemory: true,
    });
    expect(resolveSessionPolicy({ name: "envoy" })).toEqual({
      finalText: "deliver",
      autoTitle: true,
      loadMemory: false,
    });
  });

  it("applies each declared field and keeps the rest", () => {
    expect(
      resolveSessionPolicy({
        name: "concierge",
        policy: { finalText: "private", autoTitle: false },
      }),
    ).toEqual({ finalText: "private", autoTitle: false, loadMemory: false });
    expect(resolveSessionPolicy({ name: "main", policy: { loadMemory: false } }).loadMemory).toBe(
      false,
    );
  });
});
