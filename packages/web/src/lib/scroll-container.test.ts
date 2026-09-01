import { describe, expect, it } from "@rstest/core";
import {
  allowsVerticalScroll,
  findScrollableYAncestor,
  hasVerticalOverflow,
} from "./scroll-container";

function element({
  clientHeight,
  overflowY,
  parentElement = null,
  scrollHeight,
}: {
  clientHeight: number;
  overflowY: string;
  parentElement?: HTMLElement | null;
  scrollHeight: number;
}): HTMLElement {
  return {
    clientHeight,
    dataset: { overflowY },
    parentElement,
    scrollHeight,
  } as unknown as HTMLElement;
}

const overflowY = (candidate: HTMLElement) => candidate.dataset.overflowY ?? "visible";

describe("scroll-container", () => {
  it("recognizes vertical scroll overflow modes", () => {
    expect(allowsVerticalScroll("auto")).toBe(true);
    expect(allowsVerticalScroll("scroll")).toBe(true);
    expect(allowsVerticalScroll("overlay")).toBe(true);
    expect(allowsVerticalScroll("visible")).toBe(false);
    expect(allowsVerticalScroll("hidden")).toBe(false);
  });

  it("requires real vertical overflow", () => {
    expect(hasVerticalOverflow({ clientHeight: 100, scrollHeight: 101 })).toBe(false);
    expect(hasVerticalOverflow({ clientHeight: 100, scrollHeight: 102 })).toBe(true);
  });

  it("uses the nearest ancestor that can actually scroll", () => {
    const body = element({ clientHeight: 400, overflowY: "auto", scrollHeight: 900 });
    const list = element({
      clientHeight: 200,
      overflowY: "auto",
      parentElement: body,
      scrollHeight: 600,
    });
    const sentinel = element({
      clientHeight: 44,
      overflowY: "visible",
      parentElement: list,
      scrollHeight: 44,
    });

    expect(findScrollableYAncestor(sentinel, { fallback: body, getOverflowY: overflowY })).toBe(
      list,
    );
  });

  it("skips non-scrolling ancestors and falls back to the mobile body scroller", () => {
    const body = element({ clientHeight: 400, overflowY: "auto", scrollHeight: 900 });
    const list = element({
      clientHeight: 600,
      overflowY: "auto",
      parentElement: body,
      scrollHeight: 600,
    });
    const sentinel = element({
      clientHeight: 44,
      overflowY: "visible",
      parentElement: list,
      scrollHeight: 44,
    });

    expect(
      findScrollableYAncestor(sentinel, {
        boundary: body,
        fallback: body,
        getOverflowY: overflowY,
      }),
    ).toBe(body);
  });
});
