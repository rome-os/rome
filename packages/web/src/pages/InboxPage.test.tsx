// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import i18n from "@/i18n";
import InboxPage from "./InboxPage";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

// Mount-time probes the page issues; each returns an empty-but-valid payload so
// the page reaches its loaded state and renders every section. `connections`
// overrides the /api/connections body for the source-overview assertions.
function mockBackend(connections: unknown[] = []) {
  rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const url = String(input);
    const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json }) as Response;
    if (url.includes("/api/sentinel-log")) return ok([]);
    if (url.includes("/api/connections")) return ok({ connections });
    return ok({}); // /api/settings and anything else
  }) as typeof fetch);
}

// A lean /api/connections row for the source overview: grant states + whether
// the Talk capability is unlocked.
function connectionRow(service: string, grants: Record<string, string>, talkUnlocked: boolean) {
  return {
    service,
    grants,
    capabilities: { talk: { state: talkUnlocked ? "unlocked" : "needs-auth" } },
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <InboxPage />
    </MemoryRouter>,
  );
}

describe("InboxPage message sources", () => {
  it("renders 'channel settings' as a link to /settings/connections in the description", async () => {
    mockBackend();
    renderPage();

    // The Trans-embedded link only renders if the component map matches the
    // <link> tag in the i18n string — a plain-text fallback would have no role.
    const link = await screen.findByRole("link", { name: /channel settings/i });
    expect(link.getAttribute("href")).toBe("/settings/connections");
  });

  it("classifies each channel with the shared registry-native rule", async () => {
    mockBackend([
      // Talk unlocked → Connected.
      connectionRow("telegram", { bot: "authorized" }, true),
      // Conferred (even degraded) but transport not up → Configured.
      connectionRow("whatsapp", { session: "degraded" }, false),
      connectionRow("wechat", { account: "authorized" }, true),
      connectionRow("discord", { bot: "authorized" }, true),
      // Nothing conferred → Disconnected.
      connectionRow("telegram_user", { session: "unauthorized" }, false),
    ]);
    renderPage();

    const badgeOf = async (label: string) => {
      const row = (await screen.findByText(label)).parentElement as HTMLElement;
      return within(row);
    };

    expect((await badgeOf("Telegram")).getByText("Connected")).toBeTruthy();
    expect((await badgeOf("WhatsApp")).getByText("Configured")).toBeTruthy();
    expect((await badgeOf("WeChat")).getByText("Connected")).toBeTruthy();
    expect((await badgeOf("Discord")).getByText("Connected")).toBeTruthy();
    expect((await badgeOf("Telegram User")).getByText("Not connected")).toBeTruthy();
    expect((await badgeOf("Webchat")).getByText("Always on")).toBeTruthy();
  });
});

describe("InboxPage triage policy", () => {
  it("defaults trusted and reply-to levels to guardian only", async () => {
    mockBackend();
    renderPage();

    const switches = await screen.findAllByRole("switch");
    const checkedStates = switches.map((sw) => sw.getAttribute("aria-checked"));

    expect(checkedStates).toEqual([
      "true",
      "false",
      "false",
      "false",
      "true",
      "false",
      "false",
      "false",
    ]);
  });

  it("rolls a trust toggle back when the save fails", async () => {
    rs.spyOn(globalThis, "fetch").mockImplementation((async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json }) as Response;
      if (url.includes("/api/settings") && method === "PUT") {
        return { ok: false, status: 500, json: async () => ({ error: "boom" }) } as Response;
      }
      if (url.includes("/api/sentinel-log")) return ok([]);
      if (url.includes("/api/connections")) return ok({ connections: [] });
      return ok({ trustedBondLevels: ["guardian"], replyToBondLevels: [] });
    }) as typeof fetch);
    renderPage();

    // First switch is "guardian" in the trusted-levels group, on per the mock.
    const guardianSwitch = (await screen.findAllByRole("switch"))[0];
    expect(guardianSwitch.getAttribute("aria-checked")).toBe("true");

    // Optimistic flip on click…
    fireEvent.click(guardianSwitch);
    expect(guardianSwitch.getAttribute("aria-checked")).toBe("false");

    // …then rolled back once the PUT fails, so the UI matches the backend.
    await waitFor(() => expect(guardianSwitch.getAttribute("aria-checked")).toBe("true"));
  });

  it("resyncs the trust toggles when a refresh returns newer settings", async () => {
    let settingsFetches = 0;
    rs.spyOn(globalThis, "fetch").mockImplementation((async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json }) as Response;
      if (url.includes("/review") && method === "POST") return ok({ success: true });
      if (url.includes("/api/sentinel-log")) {
        return ok([
          {
            id: "s1",
            channel: "telegram",
            channelUserId: "u1",
            displayName: "Visitor",
            text: "hi",
            action: "ignored",
            response: null,
            reviewed: false,
            createdAt: new Date().toISOString(),
          },
        ]);
      }
      if (url.includes("/api/connections")) return ok({ connections: [] });
      // /api/settings: guardian is trusted on first load, dropped server-side by
      // the time the page refreshes (e.g. edited from another tab).
      settingsFetches += 1;
      return ok({ trustedBondLevels: settingsFetches === 1 ? ["guardian"] : [] });
    }) as typeof fetch);
    renderPage();

    const guardianSwitch = (await screen.findAllByRole("switch"))[0];
    expect(guardianSwitch.getAttribute("aria-checked")).toBe("true");

    // Mark-reviewed reruns loadAll; the refreshed settings must win over the
    // stale local toggle state. Re-query the switch — the page shows its
    // loading state during the refetch, remounting the section.
    fireEvent.click(await screen.findByRole("button", { name: "Mark Reviewed" }));
    await waitFor(() => {
      const sw = screen.getAllByRole("switch")[0];
      expect(sw.getAttribute("aria-checked")).toBe("false");
    });
  });
});
