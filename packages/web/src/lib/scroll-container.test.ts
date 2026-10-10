// @rstest-environment jsdom
import { afterEach, describe, expect, it } from "@rstest/core";
import { allowsVerticalScroll, findScrollableYAncestor } from "./scroll-container";

function element({
  clientHeight,
  overflowY,
  parent,
  scrollHeight,
}: {
  clientHeight: number;
  overflowY: string;
  parent?: HTMLElement;
  scrollHeight: number;
}): HTMLElement {
  const el = document.createElement("div");
  el.style.overflowY = overflowY;
  Object.defineProperty(el, "clientHeight", { value: clientHeight });
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight });
  (parent ?? document.body).appendChild(el);
  return el;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("scroll-container", () => {
  it("recognizes vertical scroll overflow modes", () => {
    expect(allowsVerticalScroll("auto")).toBe(true);
    expect(allowsVerticalScroll("scroll")).toBe(true);
    expect(allowsVerticalScroll("overlay")).toBe(true);
    expect(allowsVerticalScroll("visible")).toBe(false);
    expect(allowsVerticalScroll("hidden")).toBe(false);
  });

  it("uses the nearest ancestor that can actually scroll", () => {
    const body = element({ clientHeight: 400, overflowY: "auto", scrollHeight: 900 });
    const list = element({ clientHeight: 200, overflowY: "auto", parent: body, scrollHeight: 600 });
    const sentinel = element({
      clientHeight: 44,
      overflowY: "visible",
      parent: list,
      scrollHeight: 44,
    });

    expect(findScrollableYAncestor(sentinel, { fallback: body })).toBe(list);
  });

  it("skips non-scrolling ancestors and falls back to the mobile body scroller", () => {
    const body = element({ clientHeight: 400, overflowY: "auto", scrollHeight: 900 });
    // One pixel of slack is rounding, not overflow.
    const list = element({ clientHeight: 600, overflowY: "auto", parent: body, scrollHeight: 601 });
    const sentinel = element({
      clientHeight: 44,
      overflowY: "visible",
      parent: list,
      scrollHeight: 44,
    });

    expect(findScrollableYAncestor(sentinel, { boundary: body, fallback: body })).toBe(body);
  });
});
