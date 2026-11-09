import { describe, expect, it } from "@rstest/core";
import { type ProviderWatchSection, watchCapabilityStatus } from "./connectors.js";

const section = (
  status: ProviderWatchSection["status"],
  statusReason?: string,
): ProviderWatchSection => ({
  service: "gmail",
  label: "Gmail",
  status,
  ...(statusReason ? { statusReason } : {}),
  target: null,
  kinds: [],
  options: [],
});

describe("watchCapabilityStatus", () => {
  it("maps a provider's watch status onto the connection model", () => {
    expect(watchCapabilityStatus(section("ready"))).toEqual({ state: "unlocked" });
    expect(watchCapabilityStatus(section("not_connected", "Gmail is not connected."))).toEqual({
      state: "needs-auth",
      missingGrants: [],
    });
    // Connected but unable to receive events: unlocked, degraded with the reason.
    expect(watchCapabilityStatus(section("no_relay", "No relay mailbox."))).toEqual({
      state: "unlocked",
      degradation: { reason: "No relay mailbox." },
    });
    expect(watchCapabilityStatus(section("error"))).toEqual({
      state: "unlocked",
      degradation: { reason: "error" },
    });
  });
});
