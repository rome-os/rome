import { describe, expect, it } from "@rstest/core";
import { COLLAPSE_SNAP_OFFSET, scrollTopAfterToggle } from "./scroll-anchor";

const toggle = (input: Partial<Parameters<typeof scrollTopAfterToggle>[0]>) =>
  scrollTopAfterToggle({
    scrollTop: 1000,
    before: 300,
    after: 300,
    viewportTop: 48,
    collapsing: false,
    ...input,
  });

describe("scrollTopAfterToggle", () => {
  it("leaves the scroller alone when the bubble's top did not move", () => {
    expect(toggle({})).toBe(1000);
    expect(toggle({ collapsing: true })).toBe(1000);
  });

  it("scrolls by the distance the bubble's top moved down the screen", () => {
    // Something above the bubble grew by 40px.
    expect(toggle({ after: 340 })).toBe(1040);
  });

  it("scrolls by the distance the bubble's top moved up the screen", () => {
    expect(toggle({ after: 250, collapsing: true })).toBe(950);
  });

  it("keeps the offset of a visible top when closing, too", () => {
    expect(toggle({ before: 120, after: 150, collapsing: true })).toBe(1030);
  });

  it("brings a bubble that is closing with its top above the viewport to a step below the top edge", () => {
    // The top was 800px above the screen; closing leaves it where the page put it, at 500.
    expect(toggle({ before: -800, after: 500, collapsing: true })).toBe(
      1000 + (500 - (48 + COLLAPSE_SNAP_OFFSET)),
    );
  });

  it("does not snap a bubble that is opening, whatever the offset of its top", () => {
    expect(toggle({ before: -800, after: -760 })).toBe(1040);
  });

  it("does not snap a top that sits exactly at the viewport's top", () => {
    expect(toggle({ before: 48, after: 60, collapsing: true })).toBe(1012);
  });

  it("uses a 16px step", () => {
    expect(COLLAPSE_SNAP_OFFSET).toBe(16);
  });
});
