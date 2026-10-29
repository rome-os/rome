// @rstest-environment jsdom
import { act, cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { MemoryRouter } from "react-router-dom";
import { render } from "@/test/query-render";
import i18n from "@/i18n";
import { formatUsageReset, UsageMenu } from "./UsageMenu";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});
const usage = {
  checkedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  source: "event",
  fiveHour: { usedPercent: 29, resetsAt: new Date(Date.now() + 60_000).toISOString() },
  sevenDay: { usedPercent: 12, resetsAt: new Date(Date.now() + 5 * 86400_000).toISOString() },
};

function mount(status: unknown, enabled = true) {
  rs.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(status));
  return render(
    <MemoryRouter>
      <UsageMenu enabled={enabled} selection="claude-opus-5-5" />
    </MemoryRouter>,
  );
}

describe("UsageMenu", () => {
  it("shows remaining windows, local resets, age and AI Tools link", async () => {
    mount({
      claude: { loggedIn: true, usage },
      codex: { loggedIn: true, usage: { ...usage, fiveHour: { usedPercent: 99 } } },
    });
    await userEvent.click(await screen.findByRole("button", { name: "Usage remaining" }));
    expect(screen.getByText("5h")).toBeTruthy();
    expect(screen.getByText("Weekly")).toBeTruthy();
    expect(screen.getByText("71%")).toBeTruthy();
    expect(screen.getByText("88%")).toBeTruthy();
    expect(screen.getByText("Updated 5 min ago")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Manage in AI Tools" }).getAttribute("href")).toBe(
      "/settings/ai-tools",
    );
    expect(screen.getByText(formatUsageReset(usage.fiveHour.resetsAt, "en")!)).toBeTruthy();
  });
  it("reads a window whose reset has passed as reset, not as old numbers", async () => {
    mount({
      claude: {
        loggedIn: true,
        usage: {
          ...usage,
          fiveHour: { usedPercent: 100, resetsAt: new Date(Date.now() - 60_000).toISOString() },
        },
      },
    });
    await userEvent.click(await screen.findByRole("button", { name: "Usage remaining" }));
    expect(screen.getByText("Reset")).toBeTruthy();
    expect(screen.queryByText("0%")).toBeNull();
    expect(screen.getByText("88%")).toBeTruthy();
  });
  it("shows unavailable rather than stale bars on usage errors", async () => {
    mount({ claude: { loggedIn: true, usage: { ...usage, error: "429" } } });
    await userEvent.click(await screen.findByRole("button", { name: "Usage remaining" }));
    expect(screen.getByText("Usage is unavailable right now.")).toBeTruthy();
    expect(screen.queryByText("71%")).toBeNull();
  });
  it.each([
    { loggedIn: false, usage },
    { loggedIn: true },
    { loggedIn: true, authMethod: "environment", usage },
    { loggedIn: true, authMethod: "stored-compatible", usage },
  ])("hides for unavailable subscription status: %j", async (claude) => {
    mount({ claude });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(screen.queryByRole("button", { name: "Usage remaining" })).toBeNull();
  });
  it("does not read status when the preference is off", () => {
    mount({ claude: { loggedIn: true, usage } }, false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Usage remaining" })).toBeNull();
  });
  it("formats the reset as local time within a day and a short date beyond it", () => {
    const now = Date.parse("2026-10-29T12:00:00Z");
    expect(formatUsageReset("2026-10-29T13:00:00Z", "en-US", now)).toBe(
      new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(
        new Date("2026-10-29T13:00:00Z"),
      ),
    );
    expect(formatUsageReset("2026-11-03T13:00:00Z", "en-US", now)).toBe("Nov 3");
    expect(formatUsageReset("garbage", "en", now)).toBeNull();
  });
});
