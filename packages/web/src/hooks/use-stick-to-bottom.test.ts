import { describe, expect, it } from "@rstest/core";
import { distanceToBottom, pinnedAfterUserScroll } from "./use-stick-to-bottom";

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

describe("pinnedAfterUserScroll", () => {
  it("pins once the user reaches the bottom", () => {
    expect(pinnedAfterUserScroll({ stuck: false, atBottom: true, movedUp: false })).toBe(true);
  });

  it("releases the pin when the user scrolls up and away", () => {
    expect(pinnedAfterUserScroll({ stuck: true, atBottom: false, movedUp: true })).toBe(false);
  });

  it("keeps the pin through a downward nudge right after sending", () => {
    // A tall bubble lands past the threshold and the browser nudges the
    // scroller down by a pixel inside the gesture window of the Enter press.
    expect(pinnedAfterUserScroll({ stuck: true, atBottom: false, movedUp: false })).toBe(true);
  });

  it("stays released while the user scrolls down short of the bottom", () => {
    expect(pinnedAfterUserScroll({ stuck: false, atBottom: false, movedUp: false })).toBe(false);
  });
});
