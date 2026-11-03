import { describe, expect, it } from "@rstest/core";
import { fitTabs, MIN_TAB_WIDTH, TAB_GAP } from "./tool-tab-fit";

const ids = ["a", "b", "c", "d", "e"];
const widthFor = (tabs: number) => tabs * MIN_TAB_WIDTH + (tabs - 1) * TAB_GAP;

describe("fitTabs", () => {
  it("draws every tab until the strip is unmeasured or wide enough", () => {
    expect(fitTabs(ids, "a", null)).toEqual(ids);
    expect(fitTabs(ids, "a", widthFor(5))).toEqual(ids);
    expect(fitTabs(ids, "a", 5000)).toEqual(ids);
  });

  it("keeps the leading tabs that fit, and drops one when a tab's minimum does not fit", () => {
    expect(fitTabs(ids, "a", widthFor(3))).toEqual(["a", "b", "c"]);
    expect(fitTabs(ids, "a", widthFor(3) - 1)).toEqual(["a", "b"]);
    expect(fitTabs(ids, "b", widthFor(4))).toEqual(["a", "b", "c", "d"]);
  });

  it("puts a hidden active tab in the last slot and keeps the others in order", () => {
    expect(fitTabs(ids, "e", widthFor(3))).toEqual(["a", "b", "e"]);
    expect(fitTabs(ids, "d", widthFor(2))).toEqual(["a", "d"]);
  });

  it("leaves an active tab that is already drawn where it is", () => {
    expect(fitTabs(ids, "b", widthFor(3))).toEqual(["a", "b", "c"]);
  });

  it("always draws at least one tab, the active one when it is hidden", () => {
    expect(fitTabs(ids, "a", 0)).toEqual(["a"]);
    expect(fitTabs(ids, "e", 10)).toEqual(["e"]);
  });

  it("ignores an active id that is not a tab", () => {
    expect(fitTabs(ids, null, widthFor(2))).toEqual(["a", "b"]);
    expect(fitTabs(ids, "gone", widthFor(2))).toEqual(["a", "b"]);
  });
});
