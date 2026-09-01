import { describe, expect, it } from "@rstest/core";
import { distanceToBottom } from "./use-stick-to-bottom";

describe("distanceToBottom", () => {
  it("is zero when scrolled fully to the bottom", () => {
    expect(distanceToBottom({ scrollTop: 700, scrollHeight: 1000, clientHeight: 300 })).toBe(0);
  });

  it("grows as the viewport sits further above the bottom", () => {
    expect(distanceToBottom({ scrollTop: 600, scrollHeight: 1000, clientHeight: 300 })).toBe(100);
  });

  it("is zero for content shorter than the viewport", () => {
    expect(distanceToBottom({ scrollTop: 0, scrollHeight: 200, clientHeight: 300 })).toBe(-100);
  });
});
