import { describe, expect, it } from "@rstest/core";
import { normalizeSidebarPins } from "./AppGrid";

describe("sidebar pins", () => {
  it("keeps required pins ahead of optional pins when normalizing", () => {
    expect(
      normalizeSidebarPins([
        { type: "builtin", id: "projects" },
        { type: "builtin", id: "chat" },
      ]),
    ).toEqual([
      { type: "builtin", id: "apps" },
      { type: "builtin", id: "chat" },
      { type: "builtin", id: "projects" },
    ]);
  });

  it("moves Projects up to the fixed three ahead of an older pin list", () => {
    expect(
      normalizeSidebarPins([
        { type: "app", id: "recipe-box" },
        { type: "builtin", id: "projects" },
      ]),
    ).toEqual([
      { type: "builtin", id: "apps" },
      { type: "builtin", id: "chat" },
      { type: "builtin", id: "projects" },
      { type: "app", id: "recipe-box" },
    ]);
  });
});
