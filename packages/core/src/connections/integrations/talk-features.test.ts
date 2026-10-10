import { describe, expect, it } from "@rstest/core";
import { historyQueryLimit } from "./talk-features.js";

describe("historyQueryLimit", () => {
  it("returns a bounded default page when limit is omitted", () => {
    expect(historyQueryLimit()).toBe(100);
    expect(historyQueryLimit(Number.NaN)).toBe(100);
  });

  it("caps an explicit limit", () => {
    expect(historyQueryLimit(10_000)).toBe(1_000);
    expect(historyQueryLimit(0)).toBe(1);
  });
});
