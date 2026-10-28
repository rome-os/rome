import { describe, expect, it } from "@rstest/core";
import { isEntryActive } from "./sidebar-shared";

describe("isEntryActive", () => {
  it("lights Chat on a new chat and on an open one", () => {
    expect(isEntryActive("/chat", "/chat")).toBe(true);
    expect(isEntryActive("/chat/7b08b9bb", "/chat")).toBe(true);
  });

  it("lights Apps on the launcher only, not on an app's own page", () => {
    expect(isEntryActive("/apps", "/apps")).toBe(true);
    expect(isEntryActive("/apps/stock-daily", "/apps")).toBe(false);
  });

  it("does not light a tile for a path that merely shares its prefix", () => {
    expect(isEntryActive("/chatter", "/chat")).toBe(false);
    expect(isEntryActive("/memory/journal", "/memory")).toBe(true);
  });
});
