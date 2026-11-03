import { describe, expect, it } from "@rstest/core";
import { ActionConfigSchema } from "./artifact-config.js";

const actionConfig = {
  name: "review",
  type: "custom" as const,
  description: "Review a change",
  complexity: "simple" as const,
  speed: "fast" as const,
  reliability: "high" as const,
  sideEffects: "read-only" as const,
};

describe("action visibility", () => {
  it("defaults to public", () => {
    expect(ActionConfigSchema.parse(actionConfig).visibility).toBe("public");
  });

  it("accepts explicit visibility", () => {
    expect(ActionConfigSchema.parse({ ...actionConfig, visibility: "explicit" }).visibility).toBe(
      "explicit",
    );
  });

  it("rejects an unknown visibility", () => {
    expect(ActionConfigSchema.safeParse({ ...actionConfig, visibility: "private" }).success).toBe(
      false,
    );
  });
});
