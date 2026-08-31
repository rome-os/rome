import { describe, expect, it } from "@rstest/core";
import { DEFAULT_SIDEBAR_PINS, normalizeSidebarPins } from "./AppGrid";

describe("sidebar pins", () => {
  it("defaults first-run sidebars to Apps, Chat, and Projects", () => {
    expect(DEFAULT_SIDEBAR_PINS).toEqual([
      { type: "builtin", id: "apps" },
      { type: "builtin", id: "chat" },
      { type: "builtin", id: "projects" },
    ]);
  });

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
});
