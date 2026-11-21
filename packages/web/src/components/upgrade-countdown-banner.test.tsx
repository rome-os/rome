// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import type { UpgradeBannerState } from "@/hooks/use-upgrade-status";
import { UpgradeCountdownBanner } from "./upgrade-countdown-banner";

const status: { state: UpgradeBannerState | null } = { state: null };

rs.mock("../hooks/use-upgrade-status", () => ({
  estimatedServerNow: () => 0,
  useUpgradeStatus: () => ({
    state: status.state,
    updateNow: async () => true,
    defer: async () => true,
    dismissStalled: () => {},
  }),
}));

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(cleanup);

describe("UpgradeCountdownBanner", () => {
  it("puts the spinner before the title while Rome restarts", () => {
    status.state = {
      phase: "updating",
      targetVersion: "1.2.0",
      deadline: null,
      serverNow: 0,
      receivedAt: 0,
    };
    render(<UpgradeCountdownBanner />);

    const title = screen.getByText("Updating Rome…");
    const spinner = title.parentElement?.previousElementSibling;
    expect(spinner?.tagName.toLowerCase()).toBe("svg");
    expect(spinner?.getAttribute("class")).toContain("animate-spin");
    expect(screen.getByText(/Rome is restarting to finish the update/)).toBeTruthy();
  });

  it("shows no spinner once the update has stalled", () => {
    status.state = {
      phase: "stalled",
      targetVersion: "1.2.0",
      deadline: null,
      serverNow: 0,
      receivedAt: 0,
    };
    const { container } = render(<UpgradeCountdownBanner />);

    expect(screen.getByText("The update is taking longer than expected")).toBeTruthy();
    expect(container.querySelector(".animate-spin")).toBeNull();
  });
});
