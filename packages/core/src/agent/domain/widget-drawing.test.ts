import { describe, expect, it } from "@rstest/core";
import { showsWidgets, widgetDrawingFor } from "./widget-drawing.js";

describe("widgetDrawingFor", () => {
  it("draws cards where the place does", () => {
    expect(widgetDrawingFor({ placeDrawsCards: true, isSubagent: false })).toBe("card");
    expect(widgetDrawingFor({ placeDrawsCards: false, isSubagent: false })).toBe("plain_text");
  });

  it("never gives a subagent cards, because its next turn would not come back to it", () => {
    expect(widgetDrawingFor({ placeDrawsCards: true, isSubagent: true })).toBe("plain_text");
  });
});

describe("showsWidgets", () => {
  it("needs both a place that draws cards and a speaker", () => {
    expect(showsWidgets("card", true)).toBe(true);
    expect(showsWidgets("card", false)).toBe(false);
    expect(showsWidgets("plain_text", true)).toBe(false);
  });
});
