// @rstest-environment jsdom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { render } from "@/test/query-render";
import i18n from "@/i18n";
import { DropdownMenu, DropdownMenuContent } from "@/components/ui/dropdown-menu";
import { formatUsageReset, ProfileUsage } from "./ProfileUsage";

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

function mount(status: unknown, settings: Record<string, unknown> = {}) {
  rs.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.startsWith("/api/settings")) return Response.json(settings);
    if (url === "/api/ai-tools/status") return Response.json(status);
    return Response.json({});
  });
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route
          path="/"
          element={
            <DropdownMenu open>
              <DropdownMenuContent>
                <ProfileUsage />
              </DropdownMenuContent>
            </DropdownMenu>
          }
        />
        <Route path="/settings/ai-tools" element={<p>AI Tools page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ProfileUsage", () => {
  it("shows each signed-in subscription tool's remaining windows, local resets and age", async () => {
    mount({
      claude: { loggedIn: true, usage },
      codex: { loggedIn: true, usage: { ...usage, fiveHour: { usedPercent: 99 } } },
    });
    const claude = await screen.findByRole("group", { name: "Claude" });
    expect(within(claude).getByText("5h")).toBeTruthy();
    expect(within(claude).getByText("71%")).toBeTruthy();
    expect(within(claude).getByText("88%")).toBeTruthy();
    expect(within(claude).getByText(formatUsageReset(usage.fiveHour.resetsAt, "en")!)).toBeTruthy();
    const chatgpt = screen.getByRole("group", { name: "ChatGPT" });
    expect(within(chatgpt).getByText("1%")).toBeTruthy();
    expect(screen.getByText("Updated 5 min ago")).toBeTruthy();
  });

  it("names no tool when only one shows usage", async () => {
    mount({ claude: { loggedIn: true, usage }, codex: { loggedIn: false } });
    await screen.findByText("71%");
    expect(screen.queryByText("Claude")).toBeNull();
    expect(screen.queryByRole("group", { name: "ChatGPT" })).toBeNull();
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
    expect(await screen.findByText("Reset")).toBeTruthy();
    expect(screen.queryByText("0%")).toBeNull();
    expect(screen.getByText("88%")).toBeTruthy();
  });

  it("shows unavailable rather than stale numbers on usage errors", async () => {
    mount({ claude: { loggedIn: true, usage: { ...usage, error: "429" } } });
    expect(await screen.findByText("Usage is unavailable right now.")).toBeTruthy();
    expect(screen.queryByText("71%")).toBeNull();
  });

  it("collapses and expands without closing the menu, and links to AI Tools", async () => {
    mount({ claude: { loggedIn: true, usage } });
    const toggle = await screen.findByRole("menuitem", { name: "Usage remaining" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("71%")).toBeNull();
    await userEvent.click(toggle);
    expect(screen.getByText("71%")).toBeTruthy();
    await userEvent.click(screen.getByRole("menuitem", { name: "Manage in AI Tools" }));
    expect(await screen.findByText("AI Tools page")).toBeTruthy();
  });

  it.each([
    [{ claude: { loggedIn: false, usage } }, {}],
    [{ claude: { loggedIn: true } }, {}],
    [{ claude: { loggedIn: true, authMethod: "environment", usage } }, {}],
    [{ claude: { loggedIn: true, authMethod: "stored-compatible", usage } }, {}],
    [{ codex: { loggedIn: true, accountType: "api_key", usage } }, {}],
    [{ claude: { loggedIn: true, usage } }, { showAiToolUsage: false }],
  ])("shows nothing for a signed-out, windowless, API-key or hidden case (%#)", async (status, settings) => {
    mount(status, settings);
    await new Promise((done) => setTimeout(done, 50));
    expect(screen.queryByRole("menuitem", { name: "Usage remaining" })).toBeNull();
  });
});
