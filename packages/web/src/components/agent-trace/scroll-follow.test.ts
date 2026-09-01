import { describe, expect, it } from "@rstest/core";
import { isTraceScrollNearBottom, TRACE_SCROLL_BOTTOM_THRESHOLD_PX } from "./scroll-follow";

describe("isTraceScrollNearBottom", () => {
  it("treats an exactly bottom-pinned trace as near the bottom", () => {
    expect(isTraceScrollNearBottom(1_000, 700, 300)).toBe(true);
  });

  it("allows a small distance from the bottom for inertial scrolling and rounding", () => {
    expect(isTraceScrollNearBottom(1_000, 700 - TRACE_SCROLL_BOTTOM_THRESHOLD_PX, 300)).toBe(true);
  });

  it("detects when the user has intentionally scrolled up", () => {
    expect(isTraceScrollNearBottom(1_000, 700 - TRACE_SCROLL_BOTTOM_THRESHOLD_PX - 1, 300)).toBe(
      false,
    );
  });
});
