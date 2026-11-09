import { describe, expect, it } from "@rstest/core";
import { addressedToOf, cleanLabels } from "./event-shape.js";

describe("cleanLabels and addressedToOf", () => {
  it("keeps short lowercase words once, and reads unknown addressing as other", () => {
    expect(cleanLabels(["bot", "Bot", "bot", "ci-failed", "x".repeat(60), 3, "team:core"])).toEqual(
      ["bot", "ci-failed", "team:core"],
    );
    expect(cleanLabels("bot")).toEqual([]);
    expect(addressedToOf("copy")).toBe("copy");
    expect(addressedToOf("direct")).toBe("direct");
    expect(addressedToOf("whatever")).toBe("other");
  });
});
