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
});
