// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import i18n from "@/i18n";
import { ComposioConnectionSection } from "@/components/connections/composio-connection-section";
import { buildConnectionCards, type ConnectionCard } from "@/lib/connection-cards";
import type { ComposioCliStatus } from "@/lib/provider-types";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function status(overrides: Partial<ComposioCliStatus> = {}): ComposioCliStatus {
  return {
    installed: true,
    loggedIn: false,
    loginPending: false,
    webUrl: null,
    orgId: null,
    testUserId: null,
    error: null,
    ...overrides,
  };
}

/** The Composio broker card is synthesized by the presentation adapter (it is
 *  not a registry connection), so build it the same way the list does. */
function composioCard(cliStatus: ComposioCliStatus): ConnectionCard {
  const card = buildConnectionCards([], cliStatus).find((entry) => entry.service === "composio");
  if (!card) throw new Error("no composio card");
  return card;
}

function renderSection(
  cliStatus: ComposioCliStatus,
  {
    card = composioCard(status()),
    onRefresh = () => {},
    onFlash = () => {},
  }: {
    card?: ConnectionCard;
    onRefresh?: () => void;
    onFlash?: (message: string) => void;
  } = {},
) {
  return render(
    <ComposioConnectionSection
      card={card}
      slot={card.slots[0]}
      role="primary"
      composio={cliStatus}
      onRefresh={onRefresh}
      onFlash={onFlash}
    />,
  );
}

describe("ComposioConnectionSection", () => {
  it("renders + bullets and a Connect control when installed but not logged in", () => {
    renderSection(status({ loggedIn: false }), { card: composioCard(status({ loggedIn: false })) });
    expect(screen.getByText("This connection will let your agent")).toBeTruthy();
    expect(
      screen.getByText("Act through the third-party apps you connect via Composio"),
    ).toBeTruthy();
    expect(screen.getByText("Your Composio account")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
  });

  it("renders ✓ bullets and a Disconnect action when logged in", () => {
    renderSection(status({ loggedIn: true }), { card: composioCard(status({ loggedIn: true })) });
    expect(screen.getByText("This connection lets your agent")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  });

  it("shows the unavailable note when the CLI is not installed", () => {
    renderSection(status({ installed: false }));
    expect(screen.getByText("Composio is not available on this host.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("Disconnect posts to the composio logout endpoint and refreshes", async () => {
    const fetchMock = rs
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("{}", { status: 200 }));
    const onRefresh = rs.fn();
    renderSection(status({ loggedIn: true }), {
      card: composioCard(status({ loggedIn: true })),
      onRefresh,
    });
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integrations/composio/logout",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("Connect opens the login URL and refreshes after the account signs in", async () => {
    // login → returns the login URL; status → immediately reports loggedIn so the
    // poll exits on its first iteration.
    const fetchMock = rs.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith("/composio/login")) {
        return Promise.resolve(
          new Response(JSON.stringify({ loginUrl: "https://composio.example/login" }), {
            status: 200,
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ composio: { loggedIn: true } }), { status: 200 }),
      );
    });
    const openMock = rs.spyOn(window, "open").mockReturnValue(null);
    const onRefresh = rs.fn();
    renderSection(status({ loggedIn: false }), {
      card: composioCard(status({ loggedIn: false })),
      onRefresh,
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalled(), { timeout: 5000 });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integrations/composio/login",
      expect.objectContaining({ method: "POST" }),
    );
    expect(openMock).toHaveBeenCalledWith(
      "https://composio.example/login",
      "_blank",
      "noopener,noreferrer",
    );
  });
});
