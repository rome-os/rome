import { describe, expect, it } from "@rstest/core";
import { normalizeTab } from "./SettingsTabPage";

describe("SettingsTabPage tabs (Connection migration)", () => {
  it("has no Channels tab: chat rules live on each connection's page", () => {
    expect(normalizeTab("channels")).toBeNull();
  });

  it("still resolves Connections and the other visible tabs", () => {
    expect(normalizeTab("connections")).toBe("Connections");
    expect(normalizeTab("appearance")).toBe("Appearance");
    expect(normalizeTab("advanced")).toBe("Advanced");
  });
});
