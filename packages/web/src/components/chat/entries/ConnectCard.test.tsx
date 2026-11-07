// @rstest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { ConciergeConnectEntry } from "@rome/api-types/concierge";
import i18n from "@/i18n";

import * as connectLib from "@/lib/connect-card" with { rstest: "importActual" };

const poll = rs.hoisted(() => ({ result: true }));

// The real two-minute wait is the lib's own test; here it answers at once.
rs.mock("@/lib/connect-card", () => ({
  ...connectLib,
  waitForService: rs.fn(async () => poll.result),
}));

import { ConnectCard } from "./ConnectCard";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const OAUTH: ConciergeConnectEntry = {
  kind: "rome_oauth",
  url: "https://cloud.test/connect/code",
  available: true,
  unavailableReason: null,
};

let working: boolean;
let calls: { key: string; body: unknown }[];
let tab: { location: { href: string }; close: () => void; opener: unknown };

beforeEach(() => {
  working = false;
  poll.result = true;
  calls = [];
  tab = { location: { href: "" }, close: rs.fn(), opener: {} };
  rs.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
  rs.spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (key === "GET /api/concierge/connectors") {
      return new Response(
        JSON.stringify({ connectors: [{ service: "mail", state: working ? "working" : null }] }),
      );
    }
    return new Response(null, { status: 202 });
  }) as typeof fetch);
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function renderCard(connect: ConciergeConnectEntry = OAUTH, icon: string | null = "glyph:gmail") {
  return render(
    <MemoryRouter>
      <ConnectCard service="mail" label="Mail" icon={icon} connect={connect} chatId="concierge" />
    </MemoryRouter>,
  );
}

const notices = () => calls.filter((call) => call.key.endsWith("/service-connected"));

describe("ConnectCard", () => {
  it("puts the service's mark before its name", () => {
    const { container } = renderCard();

    const mark = container.querySelector("svg");
    const name = screen.getByText("Mail");
    expect(mark).not.toBeNull();
    expect(mark?.compareDocumentPosition(name)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("shows a tile with the initial for a service with no icon", () => {
    const { container } = renderCard(OAUTH, null);

    expect(container.querySelector("svg")).toBeNull();
    expect(screen.getByText("M")).toBeTruthy();
  });

  it("shows the service and one button, and nothing else", async () => {
    renderCard();

    expect(screen.getByText("Mail")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("opens the entry's link in a tab, shows Connected, and tells the Concierge once", async () => {
    renderCard();

    await userEvent.setup().click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByText("Connected")).toBeTruthy();
    expect(window.open).toHaveBeenCalledWith("", "_blank");
    expect(tab.location.href).toBe("https://cloud.test/connect/code");
    expect(tab.opener).toBeNull();
    await waitFor(() =>
      expect(notices()).toEqual([
        {
          key: "POST /api/concierge/chats/concierge/service-connected",
          body: { service: "mail" },
        },
      ]),
    );
  });

  it("shows Connected without waking the Concierge when the service already worked", async () => {
    working = true;
    renderCard();

    expect(await screen.findByText("Connected")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(notices()).toEqual([]);
  });

  it("offers another try, with no notice, when the service did not connect in time", async () => {
    poll.result = false;
    renderCard();

    await userEvent.setup().click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByText("Not connected yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(notices()).toEqual([]);
  });

  it("shows the reason a start failed, and closes the tab it opened", async () => {
    renderCard({
      kind: "composio",
      method: "POST",
      path: "/elsewhere",
      body: { provider: "mail" },
      needsLogin: false,
      login: { method: "POST", path: "/api/x/start" },
    });

    await userEvent.setup().click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByText("This connection cannot start here")).toBeTruthy();
    expect(tab.close).toHaveBeenCalled();
    expect(notices()).toEqual([]);
  });

  it("shows why a service cannot be connected here, with a way to Settings", async () => {
    renderCard({
      kind: "rome_oauth",
      url: null,
      available: false,
      unavailableReason: "Not set up",
    });

    expect(screen.getByText("Not set up")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe(
      "/settings/connections",
    );
  });
});

describe("ConnectCard for a service only Settings connects", () => {
  it("opens Settings in the tab and goes on once the service works", async () => {
    renderCard({ kind: "dashboard" });

    await userEvent.setup().click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByText("Connected")).toBeTruthy();
    expect(tab.location.href).toBe("/settings/connections");
  });
});
