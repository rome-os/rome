import { describe, expect, it } from "@rstest/core";
import type { MouseEvent } from "react";
import { isPlainClick } from "./plain-click";

const click = (init: Partial<MouseEvent> = {}) =>
  ({
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...init,
  }) as MouseEvent;

describe("isPlainClick", () => {
  it("takes a plain primary click", () => {
    expect(isPlainClick(click())).toBe(true);
  });

  it("leaves a click with a modifier, another button or a handled click to the browser", () => {
    for (const init of [
      { metaKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
      { defaultPrevented: true },
    ]) {
      expect(isPlainClick(click(init))).toBe(false);
    }
  });
});
