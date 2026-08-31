import { describe, expect, it } from "@rstest/core";
import { normalizeTab, TABS, VISIBLE_TABS } from "./SettingsTabPage";

describe("SettingsTabPage tabs (Connection migration)", () => {
  it("resolves /settings/channels to the shared conversation settings page", () => {
    expect(normalizeTab("channels")).toBe("Channels");
  });

  it("still resolves Connections and the other visible tabs", () => {
    expect(normalizeTab("connections")).toBe("Connections");
    expect(normalizeTab("appearance")).toBe("Appearance");
    expect(normalizeTab("advanced")).toBe("Advanced");
  });

  it("includes Channels in the tab union and visible tab bar", () => {
    expect(TABS).toContain("Channels");
    expect(VISIBLE_TABS).toContain("Channels");
  });

  it("redirects the removed Integrations tab into Connections", () => {
    expect(normalizeTab("integrations")).toBe("Connections");
    expect(TABS).not.toContain("Integrations");
    expect(VISIBLE_TABS).not.toContain("Integrations");
  });

  it("keeps Connections in the visible tab bar", () => {
    expect(VISIBLE_TABS).toContain("Connections");
  });
});
