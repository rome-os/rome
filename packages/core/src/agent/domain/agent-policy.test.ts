import { describe, expect, it } from "@rstest/core";
import { resolveAgentPolicy } from "./agent-policy.js";

describe("resolveAgentPolicy", () => {
  it("keeps today's chat behavior by default, with memory for main only", () => {
    expect(resolveAgentPolicy({ name: "main" })).toEqual({
      finalText: "deliver",
      autoTitle: true,
      loadMemory: true,
      freshSessionOnSetupChange: false,
      eventWaitDeadline: false,
    });
    expect(resolveAgentPolicy({ name: "envoy" })).toEqual({
      finalText: "deliver",
      autoTitle: true,
      loadMemory: false,
      freshSessionOnSetupChange: false,
      eventWaitDeadline: false,
    });
  });

  it("applies each declared field and keeps the rest", () => {
    expect(
      resolveAgentPolicy({
        name: "concierge",
        policy: { finalText: "private", autoTitle: false },
      }),
    ).toEqual({
      finalText: "private",
      autoTitle: false,
      loadMemory: false,
      freshSessionOnSetupChange: false,
      eventWaitDeadline: false,
    });
    expect(resolveAgentPolicy({ name: "main", policy: { loadMemory: false } }).loadMemory).toBe(
      false,
    );
    expect(
      resolveAgentPolicy({ name: "concierge", policy: { eventWaitDeadline: true } })
        .eventWaitDeadline,
    ).toBe(true);
  });
});
