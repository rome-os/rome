// @rstest-environment jsdom
import { afterEach, describe, expect, it } from "@rstest/core";
import { cleanup, render } from "@testing-library/react";
import { HorizontalScrollRail } from "./HorizontalScrollRail";

afterEach(() => cleanup());

// jsdom has no layout, so the rail's geometry and scroll offset are stubbed:
// 300px viewport over 800px of content, scrollLeft backed by a plain variable.
function renderRail(initialScrollLeft = 0) {
  render(
    <HorizontalScrollRail id="rome-news">
      <div>one</div>
      <div>two</div>
    </HorizontalScrollRail>,
  );
  const rail = document.querySelector('[data-horizontal-scroll="rome-news"]');
  if (!(rail instanceof HTMLElement)) throw new Error("rail was not rendered");
  let scrollLeft = initialScrollLeft;
  Object.defineProperty(rail, "clientWidth", { configurable: true, value: 300 });
  Object.defineProperty(rail, "scrollWidth", { configurable: true, value: 800 });
  Object.defineProperty(rail, "scrollLeft", {
    configurable: true,
    get: () => scrollLeft,
    set: (value: number) => {
      scrollLeft = value;
    },
  });
  return rail;
}

function wheel(rail: HTMLElement, init: WheelEventInit) {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
  rail.dispatchEvent(event);
  return event;
}

describe("HorizontalScrollRail wheel handling", () => {
  it("maps a vertical wheel delta onto the horizontal axis and cancels the page scroll", () => {
    const rail = renderRail();
    const event = wheel(rail, { deltaY: 120 });
    expect(rail.scrollLeft).toBe(120);
    expect(event.defaultPrevented).toBe(true);
  });

  it("clamps at the end of the rail", () => {
    const rail = renderRail(450);
    wheel(rail, { deltaY: 200 });
    expect(rail.scrollLeft).toBe(500);
  });

  it("releases the page scroll once the rail sits at an end", () => {
    const start = renderRail(0);
    expect(wheel(start, { deltaY: -120 }).defaultPrevented).toBe(false);
    expect(start.scrollLeft).toBe(0);
    cleanup();
    const end = renderRail(500);
    expect(wheel(end, { deltaY: 120 }).defaultPrevented).toBe(false);
    expect(end.scrollLeft).toBe(500);
  });

  it("leaves a trackpad's horizontal swipe to the browser", () => {
    const rail = renderRail();
    const event = wheel(rail, { deltaX: 80, deltaY: 10 });
    expect(rail.scrollLeft).toBe(0);
    expect(event.defaultPrevented).toBe(false);
  });

  it("leaves pinch-zoom to the browser", () => {
    const rail = renderRail();
    const event = wheel(rail, { deltaY: 120, ctrlKey: true });
    expect(rail.scrollLeft).toBe(0);
    expect(event.defaultPrevented).toBe(false);
  });

  it("scales line-mode deltas to pixels", () => {
    const rail = renderRail();
    wheel(rail, { deltaY: 3, deltaMode: WheelEvent.DOM_DELTA_LINE });
    expect(rail.scrollLeft).toBe(48);
  });

  it("does nothing when the content fits", () => {
    const rail = renderRail();
    Object.defineProperty(rail, "scrollWidth", { configurable: true, value: 300 });
    const event = wheel(rail, { deltaY: 120 });
    expect(rail.scrollLeft).toBe(0);
    expect(event.defaultPrevented).toBe(false);
  });
});
