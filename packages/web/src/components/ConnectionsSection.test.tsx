// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "@/i18n";
import { ConnectionsSection } from "@/components/ConnectionsSection";
import type { ApiConnection, GrantDisplay, GrantState } from "@/lib/connections-api";
import type { ComposioCliStatus } from "@/lib/provider-types";

/** A later account's channel id, opaque as core mints it. */
const SECOND_FEISHU = "c7d1a0e2-5b3f-4e8a-9c61-2f0b7d4e8a13";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  // Opening a row's detail dialog mounts ceremony cards that self-fetch their
  // transient status (verify-status, telegram user/status, ...). None of these
  // tests assert ceremony state, so a fresh minimal ok JSON keeps them quiet.
  rs.spyOn(globalThis, "fetch").mockImplementation(
    async (input) =>
      new Response(String(input) === "/api/approvals" ? "[]" : "{}", { status: 200 }),
  );
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function grantDisplay(overrides: Partial<GrantDisplay> = {}): GrantDisplay {
  return { displayName: null, handle: null, email: null, avatarUrl: null, ...overrides };
}

function connection(
  overrides: Partial<ApiConnection> & Pick<ApiConnection, "service">,
): ApiConnection {
  return {
    id: `conn-${overrides.service}`,
    label: overrides.service,
    grants: {},
    display: {},
    capabilities: {
      talk: { state: "unsupported" },
      act: { state: "unsupported" },
      watch: { state: "unsupported" },
    },
    connect: null,
    setups: {},
    channel: null,
    linkedAgent: null,
    severalAccounts: false,
    ...overrides,
  };
}

function telegramBot(state: GrantState, handle: string | null = null): ApiConnection {
  return connection({
    service: "telegram",
    grants: { bot: state },
    display: { bot: handle ? grantDisplay({ handle }) : null },
  });
}

function telegramUser(state: GrantState): ApiConnection {
  return connection({
    service: "telegram_user",
    grants: { session: state },
    display: { session: null },
  });
}

function oauth(
  service: "github" | "google" | "slack",
  state: GrantState = "unauthorized",
  display: GrantDisplay | null = null,
): ApiConnection {
  const grant = service === "slack" ? "workspace" : "user";
  return connection({
    service,
    grants: { [grant]: state },
    display: { [grant]: display },
    connect: { url: `https://oauth/${service}`, available: true, unavailableReason: null },
  });
}

/** Mirrors the old minimal channel-status fold: telegram + whatsapp offered but
 *  unconnected, webchat always on (zero grants). */
function minimalConnections(): ApiConnection[] {
  return [
    telegramBot("unauthorized"),
    connection({ service: "whatsapp", grants: { session: "unauthorized" }, display: {} }),
    connection({ service: "webchat" }),
  ];
}

function composioStatus(overrides: Partial<ComposioCliStatus> = {}): ComposioCliStatus {
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

function renderSection(
  connections: ApiConnection[] = minimalConnections(),
  composio: ComposioCliStatus | null = null,
  onRefresh: (backgroundRefresh?: boolean) => Promise<ApiConnection[] | null> = rs.fn(
    async () => null,
  ),
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ConnectionsSection
          connections={connections}
          composio={composio}
          loading={false}
          error={null}
          onRefresh={onRefresh}
          onFlash={rs.fn()}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function sectionWith(
  connections: ApiConnection[],
  onRefresh: (backgroundRefresh?: boolean) => Promise<ApiConnection[] | null>,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ConnectionsSection
          connections={connections}
          composio={null}
          loading={false}
          error={null}
          onRefresh={onRefresh}
          onFlash={rs.fn()}
        />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("ConnectionsSection — list of rows", () => {
  it("renders a row for every connection the registry reports including webchat", () => {
    renderSection([...minimalConnections(), oauth("github"), oauth("google")]);

    // telegram and whatsapp from minimalConnections, webchat always-on
    for (const label of ["Telegram", "WhatsApp", "Webchat", "GitHub", "Google"]) {
      expect(screen.getByRole("button", { name: `Open ${label}` })).toBeTruthy();
    }
  });

  it("shows the Rome mark for webchat and a mail glyph for email", () => {
    renderSection([
      ...minimalConnections(),
      connection({ service: "email", grants: { inbox: "unauthorized" } }),
    ]);

    const webchatRow = screen.getByRole("button", { name: "Open Webchat" });
    const emailRow = screen.getByRole("button", { name: "Open Email" });

    // The Rome mark is the only non-Lucide glyph a row can carry.
    const webchatLogo = webchatRow.querySelector("svg");
    expect(webchatLogo).toBeTruthy();
    expect(webchatLogo?.classList.contains("lucide")).toBe(false);
    expect(emailRow.querySelector("svg.lucide-mail")).toBeTruthy();
  });

  it("opens services in dialogs and links to pairing history and app keys", () => {
    renderSection([...minimalConnections(), oauth("github")]);

    const links = screen.queryAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/activity",
      "/settings/connections/app-keys",
    ]);
    expect(screen.getByRole("button", { name: "Open GitHub" })).toBeTruthy();
  });

  it("clicking a row opens the detail dialog with the connect ceremony", () => {
    renderSection([...minimalConnections(), oauth("github")]);

    // Dialog is closed initially.
    expect(screen.queryByText("Connect")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open GitHub" }));

    // The dialog mounts the ceremony body.
    expect(screen.getByText("Connect")).toBeTruthy();
  });

  it("a degraded OAuth grant reads Not connected with an attention-toned dot on the row (#1472)", () => {
    // The old expired-token case (client-side tokenExpiresAt clock) is now the
    // registry's own health signal: a `degraded` grant state on the connection.
    renderSection([...minimalConnections(), oauth("github", "degraded")]);

    const row = screen.getByRole("button", { name: "Open GitHub" });
    expect(within(row).getByText("Not connected")).toBeTruthy();
    const dot = row.querySelector("span[aria-hidden]");
    expect(dot).toBeTruthy();
    expect(dot?.className).toContain("bg-warning");
    expect(dot?.parentElement?.getAttribute("title")).toBe("Access expired — reconnect");
    expect(row.querySelector("svg.lucide-triangle-alert")).toBeTruthy();
  });

  it("a stale WeChat runtime reads Degraded while its grant remains authorized", () => {
    renderSection([
      ...minimalConnections(),
      connection({
        service: "wechat",
        grants: { account: "authorized" },
        capabilities: {
          talk: {
            state: "unlocked",
            degradation: {
              reason: "WeChat reported a stale session.",
              retryAt: "2026-07-20T12:00:00.000Z",
            },
          },
          act: { state: "unsupported" },
          watch: { state: "unsupported" },
        },
      }),
    ]);

    const row = screen.getByRole("button", { name: "Open WeChat" });
    expect(within(row).getByText("Degraded")).toBeTruthy();
    expect(within(row).queryByText("Connected")).toBeNull();
    expect(row.querySelector("span[aria-hidden]")?.className).toContain("bg-warning");
  });
});

describe("ConnectionsSection — Telegram fold row status", () => {
  function telegramRow(connections: ApiConnection[]): HTMLElement {
    renderSection(connections);
    return screen.getByRole("button", { name: "Open Telegram" });
  }

  it("stays a single Telegram row even when the personal account is present", () => {
    telegramRow([telegramBot("authorized", "mybot"), telegramUser("authorized")]);
    // The personal account never becomes its own row — one Telegram button.
    expect(screen.getAllByRole("button", { name: "Open Telegram" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /personal account/i })).toBeNull();
  });

  it("bot authorized + degraded personal-account session ⇒ attention override (Not connected, attention dot)", () => {
    // The old failed sessionHealth signal is now the registry's `degraded`
    // grant state on the telegram_user connection.
    const row = telegramRow([telegramBot("authorized", "mybot"), telegramUser("degraded")]);
    expect(within(row).getByText("Not connected")).toBeTruthy();
    const dot = row.querySelector("span[aria-hidden]");
    expect(dot?.className).toContain("bg-warning");
  });

  it("opening the Telegram row shows both slot cards (bot + personal account)", () => {
    renderSection([telegramBot("authorized", "mybot"), telegramUser("unauthorized")]);
    fireEvent.click(screen.getByRole("button", { name: "Open Telegram" }));

    // Both slot cards render inside the one dialog: the connected bot (identity
    // header) and the addable personal-account card (its static title).
    expect(screen.getByText("mybot")).toBeTruthy();
    expect(screen.getByText("Your account")).toBeTruthy();
  });
});

describe("ConnectionsSection — Composio row", () => {
  it("shows no Composio row until the CLI is installed", () => {
    // composio null (default) — the broker row is absent.
    renderSection();
    expect(screen.queryByText("Composio")).toBeNull();
  });

  it("shows a Composio row when installed but signed out (Not connected)", () => {
    renderSection(minimalConnections(), composioStatus({ installed: true, loggedIn: false }));
    expect(screen.getByRole("button", { name: "Open Composio" })).toBeTruthy();
    // Installed-but-signed-out reads as "Not connected".
    expect(screen.getAllByText("Not connected").length).toBeGreaterThan(0);
  });

  it("shows a connected Composio row when signed in", () => {
    renderSection(minimalConnections(), composioStatus({ installed: true, loggedIn: true }));
    fireEvent.click(screen.getByRole("button", { name: "Open Composio" }));
    // Connected card: the ✓ enablement bullet and a Disconnect action, no ceremony.
    expect(
      screen.getByText("Act through the third-party apps you connect via Composio"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
  });

  it("clicking a signed-out Composio row opens the connect ceremony", () => {
    renderSection(minimalConnections(), composioStatus({ installed: true, loggedIn: false }));
    fireEvent.click(screen.getByRole("button", { name: "Open Composio" }));
    expect(screen.getByText("Connect")).toBeTruthy();
  });
});

describe("ConnectionsSection — several accounts", () => {
  function feishu(overrides: Partial<ApiConnection> = {}): ApiConnection {
    return connection({
      service: "feishu",
      channel: "feishu",
      grants: { app: "authorized" },
      severalAccounts: true,
      ...overrides,
    });
  }

  it("lists each account as its own row and opens the one clicked", () => {
    renderSection([
      feishu(),
      feishu({
        id: "conn-feishu-2",
        channel: SECOND_FEISHU,
        display: { app: grantDisplay({ displayName: "Sales Bot" }) },
      }),
    ]);

    expect(screen.getByRole("button", { name: "Open Feishu" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Feishu · Sales Bot" }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Feishu · Sales Bot")).toBeTruthy();
  });

  it("moves the dialog to a new account once the refreshed list has it", async () => {
    const second = feishu({
      id: "conn-feishu-2",
      channel: SECOND_FEISHU,
      display: { app: grantDisplay({ displayName: "Sales Bot" }) },
    });
    rs.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input) === "/api/connections" && init?.method === "POST") {
        return new Response(JSON.stringify({ connection: second }), { status: 201 });
      }
      if (String(input) === "/api/approvals") return new Response("[]", { status: 200 });
      return new Response("{}", { status: 200 });
    });
    const onRefresh = rs.fn(async () => [feishu(), second]);
    const view = renderSection([feishu()], null, onRefresh);
    fireEvent.click(screen.getByRole("button", { name: "Open Feishu" }));
    fireEvent.click(screen.getByRole("button", { name: "Add another account" }));

    await waitFor(() => expect(onRefresh).toHaveBeenCalledWith(true));
    // The parent re-renders with the refreshed list, as SettingsTabPage does.
    view.rerender(sectionWith([feishu(), second], onRefresh));
    await waitFor(() =>
      expect(within(screen.getByRole("dialog")).getByText("Feishu · Sales Bot")).toBeTruthy(),
    );
  });

  it("keeps the dialog on the current account when the new one is not listed yet", async () => {
    const second = feishu({ id: "conn-feishu-2", channel: SECOND_FEISHU });
    rs.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input) === "/api/connections" && init?.method === "POST") {
        return new Response(JSON.stringify({ connection: second }), { status: 201 });
      }
      if (String(input) === "/api/approvals") return new Response("[]", { status: 200 });
      return new Response("{}", { status: 200 });
    });
    const onRefresh = rs.fn(async () => [feishu()]);
    renderSection([feishu()], null, onRefresh);
    fireEvent.click(screen.getByRole("button", { name: "Open Feishu" }));
    fireEvent.click(screen.getByRole("button", { name: "Add another account" }));

    await waitFor(() => expect(onRefresh).toHaveBeenCalledWith(true));
    expect(within(screen.getByRole("dialog")).getByText("Feishu")).toBeTruthy();
  });

  it("leaves the dialog closed when the guardian closed it during the add", async () => {
    const second = feishu({ id: "conn-feishu-2", channel: SECOND_FEISHU });
    rs.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input) === "/api/connections" && init?.method === "POST") {
        return new Response(JSON.stringify({ connection: second }), { status: 201 });
      }
      if (String(input) === "/api/approvals") return new Response("[]", { status: 200 });
      return new Response("{}", { status: 200 });
    });
    let finishRefresh: (list: ApiConnection[]) => void = () => {};
    const onRefresh = rs.fn(
      () =>
        new Promise<ApiConnection[] | null>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    const view = renderSection([feishu()], null, onRefresh);
    fireEvent.click(screen.getByRole("button", { name: "Open Feishu" }));
    fireEvent.click(screen.getByRole("button", { name: "Add another account" }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledWith(true));

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    finishRefresh([feishu(), second]);
    view.rerender(sectionWith([feishu(), second], onRefresh));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
