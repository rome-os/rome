import { describe, expect, it } from "@rstest/core";
import { isAnchorInView, threadAnchor } from "./thread-anchor";

describe("threadAnchor", () => {
  it("scrolls a long thread so the message keeps its place in the timeline", () => {
    // The copy sits 900px down the thread; it was 300px down the view.
    expect(
      threadAnchor({ desired: 300, copyTop: 900, slack: 0, viewHeight: 800, scrollHeight: 2000 }),
    ).toEqual({ scrollTop: 600, lift: 0 });
  });

  it("stops at either end of a long thread", () => {
    const at = (desired: number, copyTop: number) =>
      threadAnchor({ desired, copyTop, slack: 0, viewHeight: 800, scrollHeight: 1000 });
    // The thread ends 200px below the view: the message sits lower than it was.
    expect(at(100, 900)).toEqual({ scrollTop: 200, lift: 0 });
    // The message is near the thread's start: it sits higher than it was.
    expect(at(600, 100)).toEqual({ scrollTop: 0, lift: 0 });
  });

  it("lifts a thread that fits off the composer, to exactly where the message was", () => {
    // On the composer the copy sits at 600; it was at 450.
    expect(
      threadAnchor({ desired: 450, copyTop: 600, slack: 500, viewHeight: 900, scrollHeight: 900 }),
    ).toEqual({ scrollTop: 0, lift: 150 });
  });

  it("holds a short thread's message exactly, leaving space under the thread", () => {
    // The message was near the top: the whole lift is taken, however large.
    expect(
      threadAnchor({ desired: 100, copyTop: 700, slack: 650, viewHeight: 900, scrollHeight: 900 }),
    ).toEqual({ scrollTop: 0, lift: 600 });
  });

  it("never lifts past the thread's free space, nor pushes it below the composer", () => {
    const fits = (desired: number) =>
      threadAnchor({ desired, copyTop: 600, slack: 80, viewHeight: 900, scrollHeight: 900 });
    expect(fits(100)).toEqual({ scrollTop: 0, lift: 80 });
    expect(fits(800)).toEqual({ scrollTop: 0, lift: 0 });
  });

  it("keeps the message below the header and above the composer", () => {
    const place = (desired: number) =>
      threadAnchor({
        desired,
        copyTop: 900,
        slack: 0,
        viewHeight: 800,
        scrollHeight: 2000,
        minTop: 80,
        maxTop: 600,
      });
    // Its top was under the header: it sits just below it.
    expect(place(20)).toEqual({ scrollTop: 820, lift: 0 });
    // It was low, its first lines behind the composer: they show above it.
    expect(place(760)).toEqual({ scrollTop: 300, lift: 0 });
    expect(place(300)).toEqual({ scrollTop: 600, lift: 0 });
  });
});

describe("isAnchorInView", () => {
  const view = { top: 100, bottom: 700 };

  it("counts a message whose top and first lines show", () => {
    expect(isAnchorInView({ top: 300, height: 40 }, view)).toBe(true);
    expect(isAnchorInView({ top: 600, height: 400 }, view)).toBe(true);
  });

  it("does not count one above the view, under its header, or below the composer", () => {
    expect(isAnchorInView({ top: -200, height: 100 }, view)).toBe(false);
    expect(isAnchorInView({ top: 90, height: 40 }, view)).toBe(false);
    expect(isAnchorInView({ top: 680, height: 100 }, view)).toBe(false);
  });
});
