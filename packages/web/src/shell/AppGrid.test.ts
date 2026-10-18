import { describe, expect, it } from "@rstest/core";
import { normalizeSidebarPins } from "./AppGrid";

describe("sidebar pins", () => {
  it("keeps app pins in order and drops built-in pages an earlier version pinned", () => {
    expect(
      normalizeSidebarPins([
        { type: "builtin", id: "projects" },
        { type: "app", id: "recipe-box" },
        { type: "builtin", id: "chat" },
        { type: "app", id: "weather" },
      ]),
    ).toEqual([
      { type: "app", id: "recipe-box" },
      { type: "app", id: "weather" },
    ]);
  });

  it("drops duplicates and malformed entries", () => {
    expect(
      normalizeSidebarPins([
        { type: "app", id: "weather" },
        { type: "app", id: "weather" },
        { type: "app" },
        null,
        "weather",
      ]),
    ).toEqual([{ type: "app", id: "weather" }]);
  });
});
