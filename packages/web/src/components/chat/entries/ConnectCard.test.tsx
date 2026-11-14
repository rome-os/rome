// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

const COMPOSIO = (needsLogin: boolean): ConciergeConnectEntry => ({
  kind: "composio",
  method: "POST",
  path: "/api/apps/connector/connectors",
  body: { provider: "mail" },
  needsLogin,
  login: { method: "POST", path: "/api/apps/connector/login/start" },
});

let working: boolean;
/** The connector list's entry for the service now, which a click acts on. */
let fresh: ConciergeConnectEntry;
/** How the connector list answers: false is a failed read. */
let listReadable: boolean;
let calls: { key: string; body: unknown }[];
let tab: { location: { href: string }; close: () => void; opener: unknown };

beforeEach(() => {
  working = false;
  fresh = OAUTH;
  listReadable = true;
  poll.result = true;
  calls = [];
  tab = { location: { href: "" }, close: rs.fn(), opener: {} };
  rs.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
  rs.spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (key === "GET /api/concierge/connectors") {
      if (!listReadable) return new Response("{}", { status: 502 });
      return new Response(
        JSON.stringify({
          connectors: [
            {
              service: "mail",
              state: working ? "working" : null,
              connect: working ? null : fresh,
            },
          ],
        }),
      );
    }
    if (key === "POST /api/apps/connector/connectors") {
      return new Response(JSON.stringify({ authorizationUrl: "https://composio.test/auth" }));
    }
    return new Response(null, { status: 202 });
  }) as typeof fetch);
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function renderCard(
  connect: ConciergeConnectEntry = OAUTH,
  icon: string | null = "glyph:gmail",
  count = 1,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        {Array.from({ length: count }, (_, i) => (
          <ConnectCard
            key={i}
            service="mail"
            label="Mail"
            icon={icon}
            connect={connect}
            chatId="concierge"
          />
        ))}
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const notices = () => calls.filter((call) => call.key.endsWith("/service-connected"));

describe("ConnectCard", () => {
  it("reads the connector list once for every card in the chat", async () => {
    working = true;
    renderCard(OAUTH, "glyph:gmail", 3);

    await waitFor(() => expect(screen.getAllByText("Connected")).toHaveLength(3));
    expect(calls.filter((call) => call.key === "GET /api/concierge/connectors")).toHaveLength(1);
  });

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
    fresh = { ...(COMPOSIO(false) as object), path: "/elsewhere" } as ConciergeConnectEntry;
    renderCard();

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

describe("ConnectCard acts on the connector list as it is at the click", () => {
  it("does not sign in again when the saved entry asks for a sign-in the list no longer does", async () => {
    // The card was posted before Composio was signed in; it has been since.
    fresh = COMPOSIO(false);
    renderCard(COMPOSIO(true));

    await userEvent.setup().click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByText("Connected")).toBeTruthy();
    const keys = calls.map((call) => call.key);
    expect(keys).toContain("POST /api/apps/connector/connectors");
    expect(keys.some((key) => key.includes("/login/"))).toBe(false);
    expect(tab.location.href).toBe("https://composio.test/auth");
  });

  it("signs in first when the list says it must, whatever the saved entry says", async () => {
    fresh = COMPOSIO(true);
    renderCard(COMPOSIO(false));

    await userEvent.setup().click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() =>
      expect(calls.some((call) => call.key === "POST /api/apps/connector/login/start")).toBe(true),
    );
  });

  it("shows Connected and tells the Concierge once, starting nothing, when it works by the click", async () => {
    renderCard(COMPOSIO(true));
    // It turns working after the card is drawn, before the click.
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    working = true;

    await userEvent.setup().click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByText("Connected")).toBeTruthy();
    expect(tab.close).toHaveBeenCalled();
    expect(calls.some((call) => call.key.startsWith("POST /api/apps"))).toBe(false);
    await waitFor(() => expect(notices()).toHaveLength(1));
    expect(notices()[0]?.body).toEqual({ service: "mail" });
  });

  it("shows an error and starts nothing when the list cannot be read", async () => {
    renderCard(COMPOSIO(true));
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    listReadable = false;

    await userEvent.setup().click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByText("Could not check the connection")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(tab.close).toHaveBeenCalled();
    expect(calls.some((call) => call.key.startsWith("POST"))).toBe(false);
  });

  it("shows why a service cannot be connected when the list says so now", async () => {
    fresh = { kind: "rome_oauth", url: null, available: false, unavailableReason: "Not set up" };
    renderCard(OAUTH);

    await userEvent.setup().click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByText("Not set up")).toBeTruthy();
    expect(tab.location.href).toBe("");
  });
});

describe("ConnectCard when the browser blocks the tab", () => {
  it("starts nothing and points to Settings", async () => {
    rs.spyOn(window, "open").mockReturnValue(null);
    renderCard(COMPOSIO(true));
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    const before = calls.length;

    await userEvent.setup().click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByText("Pop-up blocked")).toBeTruthy();
    expect(calls).toHaveLength(before);
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe(
      "/settings/connections",
    );
    expect(notices()).toEqual([]);
  });
});

describe("ConnectCard for a service only Settings connects", () => {
  it("opens Settings in the tab and goes on once the service works", async () => {
    fresh = { kind: "dashboard" };
    renderCard({ kind: "dashboard" });

    await userEvent.setup().click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByText("Connected")).toBeTruthy();
    expect(tab.location.href).toBe("/settings/connections");
  });
});
