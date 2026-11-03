// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import i18n from "@/i18n";
import { ConnectionsSection } from "@/components/ConnectionsSection";
import type { ApiConnection, GrantDisplay, GrantState } from "@/lib/connections-api";
import type { ComposioCliStatus } from "@/lib/provider-types";
import { stateOfGrants } from "@/test/connection-state";

rs.mock("sonner", () => ({
  toast: Object.assign(rs.fn(), { success: rs.fn(), error: rs.fn() }),
}));

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
  overrides: Partial<ApiConnection> & Pick<ApiConnection, "connectionKind">,
): ApiConnection {
  return {
    id: `conn-${overrides.connectionKind}`,
    label: overrides.connectionKind,
    state: overrides.id === null ? null : stateOfGrants(overrides.grants ?? {}),
    grants: {},
    display: {},
    capabilities: {
      chat: { state: "unsupported" },
      act: { state: "unsupported" },
      watch: { state: "unsupported" },
    },
    connect: null,
    setups: {},
    channel: null,
    agent: null,
    severalAccounts: false,
    ...overrides,
  };
}

function telegramBot(state: GrantState, handle: string | null = null): ApiConnection {
  return connection({
    connectionKind: "telegram",
    grants: { bot: state },
    display: { bot: handle ? grantDisplay({ handle }) : null },
  });
}

function telegramUser(state: GrantState): ApiConnection {
  return connection({
    connectionKind: "telegram_user",
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
    connectionKind: service,
    grants: { [grant]: state },
    display: { [grant]: display },
    connect: { url: `https://oauth/${service}`, available: true, unavailableReason: null },
  });
}

/** Mirrors the old minimal channel-status fold: telegram + whatsapp offered but
 *  unconnected. */
function minimalConnections(): ApiConnection[] {
  return [
    telegramBot("unauthorized"),
    connection({ connectionKind: "whatsapp", grants: { session: "unauthorized" }, display: {} }),
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
  it("renders a row for every connection the registry reports", () => {
    renderSection([...minimalConnections(), oauth("github"), oauth("google")]);

    for (const label of ["Telegram", "WhatsApp", "GitHub", "Google"]) {
      expect(screen.getByRole("button", { name: `Open ${label}` })).toBeTruthy();
    }
  });

  it("shows a brand mark for GitHub and a mail glyph for email", () => {
    renderSection([
      ...minimalConnections(),
      oauth("github"),
      connection({ connectionKind: "email", grants: { inbox: "unauthorized" } }),
    ]);

    const githubRow = screen.getByRole("button", { name: "Open GitHub" });
    const emailRow = screen.getByRole("button", { name: "Open Email" });

    const githubLogo = githubRow.querySelector("svg");
    expect(githubLogo).toBeTruthy();
    expect(githubLogo?.classList.contains("lucide")).toBe(false);
    expect(emailRow.querySelector("svg.lucide-mail")).toBeTruthy();
  });

  it("opens services in dialogs and links to app keys", () => {
    renderSection([...minimalConnections(), oauth("github", "authorized")]);

    const links = screen.queryAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/settings/connections/app-keys",
    ]);
    expect(screen.getByRole("button", { name: "Open GitHub" })).toBeTruthy();
  });

  it("clicking a row opens the detail dialog with the connect ceremony", () => {
    renderSection([...minimalConnections(), oauth("github")]);

    // Dialog is closed initially.
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open GitHub" }));

    // The dialog mounts the ceremony body.
    expect(within(screen.getByRole("dialog")).getByText("Connect")).toBeTruthy();
  });

  it("a broken OAuth connection reads Broken with an attention-toned dot on the row (#1472)", () => {
    // The old expired-token case (client-side tokenExpiresAt clock) is now the
    // registry's own health signal: the connection reads broken.
    renderSection([...minimalConnections(), oauth("github", "degraded")]);

    const row = screen.getByRole("button", { name: "Open GitHub" });
    expect(within(row).getByText("Broken")).toBeTruthy();
    const dot = row.querySelector("span[aria-hidden]");
    expect(dot).toBeTruthy();
    expect(dot?.className).toContain("bg-warning");
    expect(dot?.parentElement?.getAttribute("title")).toBe(
      "The platform stopped accepting Rome's access. Give access again.",
    );
    expect(row.querySelector("svg.lucide-triangle-alert")).toBeTruthy();
  });

  it("a stale WeChat runtime reads Working with an attention dot while its grant remains authorized", () => {
    renderSection([
      ...minimalConnections(),
      connection({
        connectionKind: "wechat",
        grants: { account: "authorized" },
        capabilities: {
          chat: {
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
    expect(within(row).getByText("Working")).toBeTruthy();
    expect(row.querySelector("span[aria-hidden]")?.className).toContain("bg-warning");
  });
});

describe("ConnectionsSection — tabs, search and groups", () => {
  function mixed(): ApiConnection[] {
    return [
      telegramBot("authorized", "rome_bot"),
      connection({ connectionKind: "whatsapp", grants: { session: "unauthorized" }, display: {} }),
      oauth("github", "authorized"),
      oauth("slack", "degraded"),
      oauth("google"),
    ];
  }
  const tabRadio = (name: RegExp) => screen.getByRole("radio", { name });
  const rowNames = () =>
    screen
      .queryAllByRole("button", { name: /^Open / })
      .map((row) => row.getAttribute("aria-label"));

  it("opens on Connected and lists working and broken connections there", () => {
    renderSection(mixed());
    expect(tabRadio(/Connected/).getAttribute("aria-checked")).toBe("true");
    // A broken connection stays connected and leads its group.
    expect(rowNames()).toEqual(["Open Telegram", "Open Slack", "Open GitHub"]);
    expect(within(tabRadio(/Connected/)).getByText("3")).toBeTruthy();
    expect(within(tabRadio(/Available/)).getByText("2")).toBeTruthy();
  });

  it("opens on Available when nothing is connected", () => {
    renderSection(minimalConnections());
    expect(tabRadio(/Available/).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryAllByRole("link")).toEqual([]);
  });

  it("shows what an available connection does, under its group", () => {
    renderSection(mixed());
    fireEvent.click(tabRadio(/Available/));
    expect(rowNames()).toEqual(["Open WhatsApp", "Open Google"]);
    const accounts = screen.getByRole("region", { name: "Accounts and tools" });
    expect(within(accounts).getByText("Work across your Google services as you")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Messaging" })).toBeTruthy();
  });

  it("filters both tabs and offers the other tab when only it matches", () => {
    renderSection(mixed());
    fireEvent.change(screen.getByLabelText("Search connections"), {
      target: { value: "google" },
    });
    expect(rowNames()).toEqual([]);
    expect(screen.getByText("No connected service matches “google”.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show 1 in Available" }));
    expect(rowNames()).toEqual(["Open Google"]);
  });

  it("matches what a connection does, not only its name", () => {
    renderSection(mixed());
    fireEvent.click(tabRadio(/Available/));
    fireEvent.change(screen.getByLabelText("Search connections"), {
      target: { value: "google services" },
    });
    expect(rowNames()).toEqual(["Open Google"]);
  });

  it("keeps an offered service the host cannot connect marked Unavailable", () => {
    renderSection([
      connection({
        connectionKind: "shopify",
        grants: { store: "unauthorized" },
        connect: { url: null, available: false, unavailableReason: "Not configured" },
      }),
    ]);
    const row = screen.getByRole("button", { name: "Open Shopify" });
    expect(within(row).getByText("Unavailable")).toBeTruthy();
    expect(within(row).queryByText("Connect")).toBeNull();
  });

  it("says nothing is connected and offers Available, above App keys", () => {
    renderSection(minimalConnections());
    fireEvent.click(tabRadio(/Connected/));
    expect(screen.getByText("Nothing is connected yet.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show 2 in Available" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open App keys" })).toBeTruthy();
  });

  it("matches only names on Connected, where descriptions are not shown", () => {
    renderSection(mixed());
    fireEvent.change(screen.getByLabelText("Search connections"), {
      target: { value: "repositories" },
    });
    expect(rowNames()).toEqual([]);
  });

  it("stays on Available after the first service connects from it", () => {
    const onRefresh = rs.fn(async () => null);
    const { rerender } = render(sectionWith(minimalConnections(), onRefresh));
    expect(tabRadio(/Available/).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Open WhatsApp" }));
    rerender(
      sectionWith(
        [
          telegramBot("unauthorized"),
          connection({ connectionKind: "whatsapp", grants: { session: "authorized" } }),
        ],
        onRefresh,
      ),
    );
    // The open dialog hides the page from the accessibility tree.
    expect(
      screen.getByRole("radio", { name: /Available/, hidden: true }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("keeps the opening tab when a refresh brings the first connection", () => {
    const onRefresh = rs.fn(async () => null);
    const { rerender } = render(sectionWith(minimalConnections(), onRefresh));
    expect(tabRadio(/Available/).getAttribute("aria-checked")).toBe("true");
    rerender(
      sectionWith(
        [
          telegramBot("unauthorized"),
          connection({ connectionKind: "whatsapp", grants: { session: "authorized" } }),
        ],
        onRefresh,
      ),
    );
    expect(tabRadio(/Available/).getAttribute("aria-checked")).toBe("true");
  });

  it("shows App keys without a no-match message when only App keys matches", () => {
    renderSection(mixed());
    fireEvent.change(screen.getByLabelText("Search connections"), { target: { value: "app" } });
    expect(screen.getByRole("link", { name: "Open App keys" })).toBeTruthy();
    expect(screen.queryByText("No connected service matches “app”.")).toBeNull();
  });

  it("clears the search on Escape", () => {
    renderSection(mixed());
    const input = screen.getByLabelText("Search connections") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "slack" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
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

  it("bot working + broken personal account ⇒ attention override (Broken, attention dot)", () => {
    // The old failed sessionHealth signal is now the registry's broken state
    // on the telegram_user connection.
    const row = telegramRow([telegramBot("authorized", "mybot"), telegramUser("degraded")]);
    expect(within(row).getByText("Broken")).toBeTruthy();
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

  it("offers a Composio sign-in under Available while signed out", () => {
    renderSection(minimalConnections(), composioStatus({ installed: true, loggedIn: false }));
    // The Via Composio group's banner stands in for the signed-out account row,
    // even before any Composio service is listed.
    expect(screen.queryByRole("button", { name: "Open Composio" })).toBeNull();
    const group = screen.getByRole("region", { name: "Via Composio" });
    expect(within(group).getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Available/ }).getAttribute("aria-checked")).toBe(
      "true",
    );
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

  it("the Composio sign-in opens the connect ceremony", () => {
    renderSection(minimalConnections(), composioStatus({ installed: true, loggedIn: false }));
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(within(screen.getByRole("dialog")).getByText("Connect")).toBeTruthy();
  });
});

describe("ConnectionsSection — several accounts", () => {
  /** A new account's setup start, answered as connected at once. */
  function connectedSetup(connectionId: string | null) {
    return {
      cid: "cid-new",
      state: { status: "done", grant: connectionId ? { connectionId } : {} },
      reattached: false,
    };
  }

  function feishu(overrides: Partial<ApiConnection> = {}): ApiConnection {
    return connection({
      connectionKind: "feishu",
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
      if (String(input).endsWith("/setup") && init?.method === "POST") {
        return new Response(JSON.stringify(connectedSetup(second.id)), { status: 200 });
      }
      if (String(input) === "/api/approvals") return new Response("[]", { status: 200 });
      return new Response("{}", { status: 200 });
    });
    const onRefresh = rs.fn(async () => [feishu(), second]);
    const view = renderSection([feishu()], null, onRefresh);
    fireEvent.click(screen.getByRole("button", { name: "Open Feishu" }));
    fireEvent.click(screen.getByRole("button", { name: "Add another account" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

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
      if (String(input).endsWith("/setup") && init?.method === "POST") {
        return new Response(JSON.stringify(connectedSetup(second.id)), { status: 200 });
      }
      if (String(input) === "/api/approvals") return new Response("[]", { status: 200 });
      return new Response("{}", { status: 200 });
    });
    const onRefresh = rs.fn(async () => [feishu()]);
    renderSection([feishu()], null, onRefresh);
    fireEvent.click(screen.getByRole("button", { name: "Open Feishu" }));
    fireEvent.click(screen.getByRole("button", { name: "Add another account" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(onRefresh).toHaveBeenCalledWith(true));
    expect(within(screen.getByRole("dialog")).getByText("Feishu")).toBeTruthy();
  });

  it("leaves the dialog closed when the guardian closed it during the add", async () => {
    const second = feishu({ id: "conn-feishu-2", channel: SECOND_FEISHU });
    rs.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith("/setup") && init?.method === "POST") {
        return new Response(JSON.stringify(connectedSetup(second.id)), { status: 200 });
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
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledWith(true));

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    finishRefresh([feishu(), second]);
    view.rerender(sectionWith([feishu(), second], onRefresh));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("ConnectionsSection — Composio services", () => {
  const catalog = [
    { slug: "gmail", name: "Gmail", scope: "Reads and sends your email.", glyph: "gmail" },
    { slug: "notion", name: "Notion", scope: "Reads and writes your pages.", glyph: "notion" },
    { slug: "linear", name: "Linear", scope: "Tracks issues and projects.", glyph: "linear" },
    { slug: "github", name: "GitHub", scope: "", glyph: "github", romeManaged: true },
  ];
  const accounts = [
    { id: "a", toolkitSlug: "gmail", status: "ACTIVE" },
    { id: "b", toolkitSlug: "notion", status: "EXPIRED" },
    // The account core bridges from Rome's own GitHub connection.
    { id: "c", toolkitSlug: "github", status: "ACTIVE" },
  ];
  let failAccounts = false;
  let gmailGone = false;
  let calls: { url: string; method: string }[] = [];

  beforeEach(() => {
    calls = [];
    failAccounts = false;
    gmailGone = false;
    rs.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url === "/api/apps/connector/catalog") return Response.json({ items: catalog });
      if (url === "/api/apps/connector/connectors" && method === "GET")
        return failAccounts
          ? Response.json({ error: "composio_unavailable" }, { status: 502 })
          : Response.json({
              items: accounts.filter((account) => !(gmailGone && account.toolkitSlug === "gmail")),
            });
      if (url === "/api/apps/connector/connectors" && method === "POST")
        return Response.json({ authorizationUrl: "https://composio.example/auth/linear" });
      if (url.startsWith("/api/apps/connector/connectors/") && method === "DELETE")
        return Response.json({ ok: true, deleted: 1 });
      return new Response(url === "/api/approvals" ? "[]" : "{}", { status: 200 });
    });
  });

  const signedIn = () => composioStatus({ installed: true, loggedIn: true });
  const signedOut = () => composioStatus({ installed: true, loggedIn: false });

  it("lists connected services under Accounts, marked via Composio, broken ones leading", async () => {
    renderSection([oauth("github", "authorized")], signedIn());
    const accountsGroup = screen.getByRole("region", { name: "Accounts and tools" });
    await within(accountsGroup).findByRole("button", { name: "Open Gmail" });
    const names = within(accountsGroup)
      .getAllByRole("button")
      .map((row) => row.getAttribute("aria-label"));
    // A broken Composio service leads the group like a broken Rome one, and the
    // bridged GitHub account never shows as a Composio row.
    expect(names).toEqual(["Open Notion", "Open GitHub", "Open Composio", "Open Gmail"]);
    const notion = within(accountsGroup).getByRole("button", { name: "Open Notion" });
    expect(within(notion).getByText("via Composio")).toBeTruthy();
    expect(within(notion).getByText("Broken")).toBeTruthy();
  });

  it("offers the rest under Via Composio, and starts a connect in a new tab", async () => {
    const open = rs.spyOn(window, "open").mockReturnValue(null);
    renderSection([oauth("github", "authorized")], signedIn());
    fireEvent.click(screen.getByRole("radio", { name: /Available/ }));
    const group = await screen.findByRole("region", { name: "Via Composio" });
    expect(within(group).queryByText("Sign in to Composio to connect these services.")).toBeNull();
    fireEvent.click(await within(group).findByRole("button", { name: "Connect Linear" }));
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        "https://composio.example/auth/linear",
        "_blank",
        "noopener,noreferrer",
      ),
    );
    expect(calls).toContainEqual({ url: "/api/apps/connector/connectors", method: "POST" });
  });

  it("asks for a Composio sign-in first, and lists no connected services while signed out", async () => {
    renderSection([oauth("github", "authorized")], signedOut());
    fireEvent.click(screen.getByRole("radio", { name: /Available/ }));
    const group = await screen.findByRole("region", { name: "Via Composio" });
    expect(within(group).getByText("Sign in to Composio to connect these services.")).toBeTruthy();
    const gmail = await within(group).findByRole("button", { name: "Connect Gmail" });
    expect(gmail.hasAttribute("disabled")).toBe(true);
    // The banner stands in for the signed-out Composio account row.
    expect(screen.queryByRole("button", { name: "Open Composio" })).toBeNull();
    expect(calls.some((call) => call.url === "/api/apps/connector/connectors")).toBe(false);
    fireEvent.click(within(group).getByRole("button", { name: "Sign in" }));
    expect(within(screen.getByRole("dialog")).getByText("Connect")).toBeTruthy();
  });

  it("disconnects a connected service only after confirming", async () => {
    renderSection([oauth("github", "authorized")], signedIn());
    fireEvent.click(await screen.findByRole("button", { name: "Open Gmail" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Reads and sends your email.")).toBeTruthy();
    // Gmail works, so there is nothing to reconnect.
    expect(within(dialog).queryByRole("button", { name: "Reconnect" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Disconnect" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: "/api/apps/connector/connectors/gmail",
        method: "DELETE",
      }),
    );
  });

  it("finds a Composio service by what it does on Available", async () => {
    renderSection([oauth("github", "authorized")], signedIn());
    fireEvent.click(screen.getByRole("radio", { name: /Available/ }));
    await screen.findByRole("button", { name: "Connect Linear" });
    fireEvent.change(screen.getByLabelText("Search connections"), {
      target: { value: "issues" },
    });
    expect(screen.getByRole("button", { name: "Connect Linear" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open Google" })).toBeNull();
  });

  it("shows a Composio load failure on Connected, with a retry", async () => {
    failAccounts = true;
    renderSection([oauth("github", "authorized")], signedIn());
    expect(await screen.findByText("Couldn't load the Composio services.")).toBeTruthy();
    failAccounts = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "Open Gmail" })).toBeTruthy();
  });

  it("shows no Composio row while the catalog has not loaded", async () => {
    rs.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/apps/connector/catalog")
        return Response.json({ error: "unavailable" }, { status: 503 });
      if (url === "/api/apps/connector/connectors") return Response.json({ items: accounts });
      return new Response(url === "/api/approvals" ? "[]" : "{}", { status: 200 });
    });
    renderSection([oauth("github", "authorized")], signedIn());
    expect(await screen.findByText("Couldn't load the Composio services.")).toBeTruthy();
    // Without the catalog, the bridged GitHub account could pass for a service.
    expect(screen.queryByRole("button", { name: "Open github" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Gmail" })).toBeNull();
  });

  it("offers to open the authorize tab again, in case the browser blocked it", async () => {
    const open = rs.spyOn(window, "open").mockReturnValue(null);
    rs.mocked(toast).mockClear();
    renderSection([oauth("github", "authorized")], signedIn());
    fireEvent.click(screen.getByRole("radio", { name: /Available/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Connect Linear" }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    const options = rs.mocked(toast).mock.calls[0]?.[1] as {
      duration: number;
      action: { label: string; onClick: () => void };
    };
    expect(options.action.label).toBe("Open tab");
    // It stays until closed, so a blocked tab noticed late can still open.
    expect(options.duration).toBe(Number.POSITIVE_INFINITY);
    open.mockClear();
    options.action.onClick();
    expect(open).toHaveBeenCalledWith(
      "https://composio.example/auth/linear",
      "_blank",
      "noopener,noreferrer",
    );
  });

  describe("after the authorize tab comes back", () => {
    function renderReturn(search: string, composio: ComposioCliStatus | null = signedIn()) {
      let location = "";
      function Probe() {
        location = useLocation().search;
        return null;
      }
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const tree = (status: ComposioCliStatus | null) => (
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[`/settings/connections${search}`]}>
            <ConnectionsSection
              connections={[oauth("github", "authorized")]}
              composio={status}
              loading={false}
              error={null}
              onRefresh={rs.fn(async () => null)}
              onFlash={rs.fn()}
            />
            <Probe />
          </MemoryRouter>
        </QueryClientProvider>
      );
      const { rerender } = render(tree(composio));
      return {
        location: () => location,
        update: (status: ComposioCliStatus) => rerender(tree(status)),
      };
    }

    beforeEach(() => {
      rs.mocked(toast.success).mockClear();
      rs.mocked(toast.error).mockClear();
    });

    it("says the service connected, by name, and drops just those params", async () => {
      const { location } = renderReturn("?connector=gmail&status=ACTIVE&keep=1");
      await waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith("Gmail connected.", expect.anything()),
      );
      await waitFor(() => expect(location()).toBe("?keep=1"));
      expect(toast.error).not.toHaveBeenCalled();
    });

    it("waits for the catalog to name the service when the Composio status comes late", async () => {
      const { update } = renderReturn("?connector=gmail&status=ACTIVE", null);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(toast.success).not.toHaveBeenCalled();
      update(signedIn());
      await waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith("Gmail connected.", expect.anything()),
      );
      expect(toast.success).toHaveBeenCalledTimes(1);
    });

    it("says a declined or failed connect did not finish", async () => {
      const { location } = renderReturn("?connector=notion&status=failed");
      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          "Couldn't finish connecting Notion. Try again.",
          expect.anything(),
        ),
      );
      await waitFor(() => expect(location()).toBe(""));
      expect(toast.success).not.toHaveBeenCalled();
    });
  });

  it("lists no Composio service until the connected accounts load", async () => {
    let release: () => void = () => {};
    const accountsLoaded = new Promise<void>((resolve) => {
      release = resolve;
    });
    rs.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const url = String(input);
      calls.push({ url, method: "GET" });
      if (url === "/api/apps/connector/catalog") return Response.json({ items: catalog });
      if (url === "/api/apps/connector/connectors") {
        await accountsLoaded;
        return Response.json({ items: accounts });
      }
      return new Response(url === "/api/approvals" ? "[]" : "{}", { status: 200 });
    });
    renderSection([oauth("github", "authorized")], signedIn());
    fireEvent.click(screen.getByRole("radio", { name: /Available/ }));
    await waitFor(() =>
      expect(calls.some((call) => call.url === "/api/apps/connector/catalog")).toBe(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Connected Gmail must not show as one to connect while its account loads.
    expect(screen.queryByRole("button", { name: "Connect Gmail" })).toBeNull();
    release();
    expect(await screen.findByRole("button", { name: "Connect Linear" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect Gmail" })).toBeNull();
  });

  it("opens the next service fresh after one vanishes mid-confirmation", async () => {
    renderSection([oauth("github", "authorized")], signedIn());
    fireEvent.click(await screen.findByRole("button", { name: "Open Gmail" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Disconnect" }));
    expect(within(screen.getByRole("dialog")).getByText(/Disconnect Gmail\?/)).toBeTruthy();
    // Gmail is disconnected elsewhere; the refetch on return drops its row,
    // which closes the dialog without going through its Close button.
    gmailGone = true;
    fireEvent(window, new Event("visibilitychange"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(await screen.findByRole("button", { name: "Open Notion" }));
    expect(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Reconnect" }),
    ).toBeTruthy();
  });
});
