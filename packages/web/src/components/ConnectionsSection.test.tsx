// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import i18n from "@/i18n";
import { ConnectionsSection } from "@/components/ConnectionsSection";
import SettingsDialog from "@/pages/SettingsDialog";
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
  // Opening a row's detail pane mounts ceremony cards that self-fetch their
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

/** Leaves the open detail pane by its back button. */
const goBack = () =>
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Connections" }));

const connectedList = () => screen.getByRole("region", { name: /^Connected/ });
const addList = () => screen.getByRole("region", { name: "Add a connection" });
const namesIn = (region: HTMLElement) =>
  within(region)
    .queryAllByRole("button", { name: /^(Open|Connect) / })
    .map((card) => card.getAttribute("aria-label"));

describe("App document access visibility", () => {
  it("hides Feishu-only controls without a configured bot and shows them when one exists", () => {
    const view = renderSection([
      ...minimalConnections(),
      connection({ connectionKind: "feishu", id: null }),
    ]);
    expect(screen.queryByRole("button", { name: "App document access" })).toBeNull();
    view.rerender(
      sectionWith(
        [
          ...minimalConnections(),
          connection({ connectionKind: "feishu", grants: { app: "authorized" } }),
        ],
        async () => null,
      ),
    );
    expect(screen.getByRole("button", { name: "App document access" })).toBeTruthy();
  });
});

describe("ConnectionsSection — cards", () => {
  it("renders a card for every connection the registry reports", () => {
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

  it("opens every service in place, with no links away from the tab", () => {
    renderSection([...minimalConnections(), oauth("github", "authorized")]);

    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(within(connectedList()).getByRole("button", { name: "Open GitHub" })).toBeTruthy();
  });

  it("clicking a card opens the detail pane with the connect ceremony", () => {
    renderSection([...minimalConnections(), oauth("github")]);

    // No pane is open initially.
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open GitHub" }));

    // The pane mounts the ceremony body.
    expect(within(screen.getByRole("dialog")).getByText("Connect")).toBeTruthy();
  });

  it("a broken OAuth connection reads Broken with an attention-toned dot on the card (#1472)", () => {
    // The old expired-token case (client-side tokenExpiresAt clock) is now the
    // registry's own health signal: the connection reads broken.
    renderSection([...minimalConnections(), oauth("github", "degraded")]);

    const row = within(connectedList()).getByRole("button", { name: "Open GitHub" });
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

    const row = within(connectedList()).getByRole("button", { name: "Open WeChat" });
    expect(within(row).getByText("Working")).toBeTruthy();
    expect(row.querySelector("span[aria-hidden]")?.className).toContain("bg-warning");
  });
});

function mixed(): ApiConnection[] {
  return [
    telegramBot("authorized", "rome_bot"),
    connection({ connectionKind: "whatsapp", grants: { session: "unauthorized" }, display: {} }),
    oauth("github", "authorized"),
    oauth("slack", "degraded"),
    oauth("google"),
  ];
}

describe("ConnectionsSection — Connected and Add", () => {
  it("lists connected services with whatever needs attention first, and the rest under Add", () => {
    renderSection(mixed());
    expect(connectedList().getAttribute("aria-labelledby")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Connected · 3" })).toBeTruthy();
    // A broken connection stays connected and leads the list.
    expect(namesIn(connectedList())).toEqual(["Open Slack", "Open Telegram", "Open GitHub"]);
    expect(namesIn(addList())).toEqual(["Open WhatsApp", "Open Google"]);
  });

  it("shows status on Connected cards and what a service does only on hover under Add", () => {
    renderSection(mixed());
    const github = within(connectedList()).getByRole("button", { name: "Open GitHub" });
    const google = within(addList()).getByRole("button", { name: "Open Google" });
    expect(within(github).getByText("Working")).toBeTruthy();
    expect(within(google).queryByText("Connect")).toBeNull();
    expect(within(google).queryByText("Work across your Google services as you")).toBeNull();
    expect(google.getAttribute("title")).toBe("Work across your Google services as you");
  });

  it("opens the connected detail and the unconnected connect ceremony", () => {
    renderSection(mixed());
    fireEvent.click(screen.getByRole("button", { name: "Open GitHub" }));
    expect(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Disconnect" }),
    ).toBeTruthy();
    goBack();
    fireEvent.click(screen.getByRole("button", { name: "Open Google" }));
    expect(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Connect" }),
    ).toBeTruthy();
  });

  it("leaves Connected out while nothing is connected", () => {
    renderSection(minimalConnections());
    expect(screen.queryByRole("region", { name: /^Connected/ })).toBeNull();
    expect(namesIn(addList())).toEqual(["Open Telegram", "Open WhatsApp"]);
  });

  it("keeps an offered service the host cannot connect marked Unavailable", () => {
    renderSection([
      connection({
        connectionKind: "shopify",
        grants: { store: "unauthorized" },
        connect: { url: null, available: false, unavailableReason: "Not configured" },
      }),
    ]);
    const row = within(addList()).getByRole("button", { name: "Open Shopify" });
    expect(within(row).getByText("Unavailable").getAttribute("title")).toBe("Not configured");
  });

  it("searches both lists, matching what a service does only under Add", () => {
    renderSection([oauth("google"), oauth("github", "authorized")]);
    const input = screen.getByLabelText("Search connections");
    fireEvent.change(input, { target: { value: "google services" } });
    expect(namesIn(addList())).toEqual(["Open Google"]);
    expect(screen.queryByRole("region", { name: /^Connected/ })).toBeNull();
    fireEvent.change(input, { target: { value: "github" } });
    expect(namesIn(connectedList())).toEqual(["Open GitHub"]);
    expect(screen.queryByRole("region", { name: "Add a connection" })).toBeNull();
    // GitHub's description names repositories, but a connected card shows none.
    fireEvent.change(input, { target: { value: "repositories" } });
    expect(screen.queryAllByRole("button", { name: /^Open / })).toHaveLength(0);
    expect(screen.getByText("No service matches “repositories”.")).toBeTruthy();
  });

  it("moves a service to Connected when a refresh connects it during a search", () => {
    const onRefresh = rs.fn(async () => null);
    const { rerender } = render(sectionWith([oauth("google")], onRefresh));
    fireEvent.change(screen.getByLabelText("Search connections"), {
      target: { value: "google" },
    });
    expect(namesIn(addList())).toEqual(["Open Google"]);
    rerender(sectionWith([oauth("google", "authorized")], onRefresh));
    const google = within(connectedList()).getByRole("button", { name: "Open Google" });
    expect(within(google).getByText("Working")).toBeTruthy();
  });

  it("clears the search on Escape", () => {
    renderSection(mixed());
    const input = screen.getByLabelText("Search connections") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "slack" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
  });
});

/** The section as Settings shows it: inside the Settings dialog. */
function renderInSettings(
  connections: ApiConnection[],
  composio: ComposioCliStatus | null = null,
  onRefresh: (backgroundRefresh?: boolean) => Promise<ApiConnection[] | null> = rs.fn(
    async () => null,
  ),
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const closed = rs.fn();
  const section = (list: ApiConnection[]) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/settings/connections"]}>
        <SettingsDialog onClose={closed}>
          <ConnectionsSection
            connections={list}
            composio={composio}
            loading={false}
            error={null}
            onRefresh={onRefresh}
            onFlash={rs.fn()}
          />
        </SettingsDialog>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(section(connections));
  return {
    closed,
    settings: screen.getByRole("dialog", { name: "Settings" }),
    rerender: (list: ApiConnection[]) => view.rerender(section(list)),
  };
}

/** Every dialog in the document that does not sit inside Settings. */
const dialogsOutside = (settings: HTMLElement) =>
  [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].filter(
    (dialog) => !settings.contains(dialog),
  );

describe("ConnectionsSection — inside Settings", () => {
  it("opens a card's detail in place, and Escape returns to the card", () => {
    const { closed, settings } = renderInSettings(mixed());
    fireEvent.click(screen.getByRole("button", { name: "Open GitHub" }));

    const pane = within(settings).getByRole("dialog", { name: "GitHub" });
    expect(within(pane).getByRole("button", { name: "Disconnect" })).toBeTruthy();
    expect(dialogsOutside(settings)).toEqual([]);
    expect(within(settings).queryByRole("region", { name: /^Connected/ })).toBeNull();

    fireEvent.keyDown(document.activeElement ?? document, { key: "Escape" });
    expect(closed).not.toHaveBeenCalled();
    expect(within(settings).queryByRole("dialog", { name: "GitHub" })).toBeNull();
    const card = within(connectedList()).getByRole("button", { name: "Open GitHub" });
    expect(document.activeElement).toBe(card);
  });

  it("confirms a Telegram disconnect in the one dialog on Settings, which Escape leaves alone", () => {
    // An account an agent is linked to asks before it is removed.
    const bot = { ...telegramBot("authorized", "mybot"), link: "own_account" as const };
    const { closed, settings } = renderInSettings([bot]);
    fireEvent.click(screen.getByRole("button", { name: "Open Telegram" }));
    const pane = within(settings).getByRole("dialog", { name: "Telegram" });
    fireEvent.click(within(pane).getByRole("button", { name: "Disconnect" }));
    const [confirm] = dialogsOutside(settings);
    expect(dialogsOutside(settings)).toHaveLength(1);

    // A destructive confirm takes no Escape, and Settings under it does not see one.
    fireEvent.keyDown(document.activeElement ?? document, { key: "Escape" });
    expect(dialogsOutside(settings)).toEqual([confirm]);
    expect(closed).not.toHaveBeenCalled();

    fireEvent.click(within(confirm as HTMLElement).getByRole("button", { name: "Cancel" }));
    expect(dialogsOutside(settings)).toEqual([]);
    expect(within(settings).getByRole("dialog", { name: "Telegram" })).toBeTruthy();
  });

  it("hands focus to a card connected from its pane, now under Connected", () => {
    const onRefresh = rs.fn(async () => null);
    const { rerender } = renderInSettings([oauth("google")], null, onRefresh);
    fireEvent.click(screen.getByRole("button", { name: "Open Google" }));
    rerender([oauth("google", "authorized")]);
    fireEvent.keyDown(document.activeElement ?? document, { key: "Escape" });
    expect(document.activeElement).toBe(
      within(connectedList()).getByRole("button", { name: "Open Google" }),
    );
  });

  it("refreshes in the background from a pane, so no loading skeleton shows above it", async () => {
    const onRefresh = rs.fn(async () => null);
    renderSection([oauth("github", "authorized")], null, onRefresh);
    fireEvent.click(screen.getByRole("button", { name: "Open GitHub" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    expect(onRefresh.mock.calls.every(([background]) => background === true)).toBe(true);
  });
});

describe("ConnectionsSection — Telegram fold card status", () => {
  function telegramRow(connections: ApiConnection[]): HTMLElement {
    renderSection(connections);
    return screen.getByRole("button", { name: "Open Telegram" });
  }

  it("stays a single Telegram card even when the personal account is present", () => {
    telegramRow([telegramBot("authorized", "mybot"), telegramUser("authorized")]);
    // The personal account never becomes its own card — one Telegram button.
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

  it("opening the Telegram card shows both slot cards (bot + personal account)", () => {
    renderSection([telegramBot("authorized", "mybot"), telegramUser("unauthorized")]);
    fireEvent.click(screen.getByRole("button", { name: "Open Telegram" }));

    // Both slot cards render inside the one pane: the connected bot (identity
    // header) and the addable personal-account card (its static title).
    expect(screen.getByText("mybot")).toBeTruthy();
    expect(screen.getByText("Your account")).toBeTruthy();
  });
});

describe("ConnectionsSection — Composio account", () => {
  it("shows no Composio card until the CLI is installed", () => {
    // composio null (default) — the broker card is absent.
    renderSection();
    expect(screen.queryByText("Composio")).toBeNull();
  });

  it("offers a Composio sign-in under Add while signed out", () => {
    renderSection(minimalConnections(), composioStatus({ installed: true, loggedIn: false }));
    // The sign-in stands in for the signed-out account card, even before any
    // Composio service is listed.
    expect(screen.queryByRole("button", { name: "Open Composio" })).toBeNull();
    expect(within(addList()).getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it("keeps the signed-out Composio sign-in when a search names Composio", () => {
    renderSection(minimalConnections(), composioStatus({ installed: true, loggedIn: false }));
    const input = screen.getByLabelText("Search connections");
    fireEvent.change(input, { target: { value: "composio" } });
    expect(within(addList()).getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByText(/No service matches/)).toBeNull();
    fireEvent.change(input, { target: { value: "telegram" } });
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("lists the Composio account under Connected when signed in", () => {
    renderSection(minimalConnections(), composioStatus({ installed: true, loggedIn: true }));
    fireEvent.click(within(connectedList()).getByRole("button", { name: "Open Composio" }));
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

  it("moves the pane to a new account once the refreshed list has it", async () => {
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

  it("keeps the pane on the current account when the new one is not listed yet", async () => {
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

  it("leaves the pane closed when the guardian closed it during the add", async () => {
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

    goBack();
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
  let linearConnected = false;
  let calls: { url: string; method: string }[] = [];

  beforeEach(() => {
    calls = [];
    failAccounts = false;
    gmailGone = false;
    linearConnected = false;
    rs.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url === "/api/apps/connector/catalog") return Response.json({ items: catalog });
      if (url === "/api/apps/connector/connectors" && method === "GET")
        return failAccounts
          ? Response.json({ error: "composio_unavailable" }, { status: 502 })
          : Response.json({
              items: [
                ...accounts.filter((account) => !(gmailGone && account.toolkitSlug === "gmail")),
                ...(linearConnected
                  ? [{ id: "linear-account", toolkitSlug: "linear", status: "ACTIVE" }]
                  : []),
              ],
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

  it.each([
    { query: "gmail", list: "connected", row: "Open Gmail" },
    { query: "linear", list: "add", row: "Connect Linear" },
  ])("shows a late Composio match for $query in its list", async ({ query, list, row }) => {
    let release: () => void = () => {};
    const loaded = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = rs.mocked(globalThis.fetch).getMockImplementation()!;
    rs.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      if (String(input) === "/api/apps/connector/connectors") await loaded;
      return fetch(input, init);
    });
    renderSection([oauth("github", "authorized")], signedIn());
    fireEvent.change(screen.getByLabelText("Search connections"), { target: { value: query } });
    release();
    await screen.findByRole("button", { name: row });
    const region = list === "connected" ? connectedList() : addList();
    expect(within(region).getByRole("button", { name: row })).toBeTruthy();
  });

  it("moves a Composio service between the lists as a refresh connects or drops it", async () => {
    gmailGone = true;
    renderSection([oauth("github", "authorized")], signedIn());
    fireEvent.change(screen.getByLabelText("Search connections"), { target: { value: "gmail" } });
    await screen.findByRole("button", { name: "Connect Gmail" });
    expect(screen.queryByRole("region", { name: /^Connected/ })).toBeNull();
    gmailGone = false;
    fireEvent(window, new Event("visibilitychange"));
    const gmail = await screen.findByRole("button", { name: "Open Gmail" });
    expect(connectedList().contains(gmail)).toBe(true);
    expect(screen.queryByRole("region", { name: "Add a connection" })).toBeNull();
  });

  it("lists connected Composio services under Connected and the rest under Add", async () => {
    renderSection([oauth("github", "authorized")], signedIn());
    await screen.findByRole("button", { name: "Connect Linear" });
    expect(namesIn(addList())).toEqual(["Connect Linear"]);
    const gmail = within(connectedList()).getByRole("button", { name: "Open Gmail" });
    expect(within(gmail).getByText("Working")).toBeTruthy();
    expect(within(gmail).queryByText("Reads and sends your email.")).toBeNull();
    expect(
      within(addList()).getByRole("button", { name: "Connect Linear" }).getAttribute("title"),
    ).toBe("Tracks issues and projects.");
    fireEvent.click(gmail);
    expect(
      within(screen.getByRole("dialog")).getByText(
        "Rome reaches this service through your Composio account.",
      ),
    ).toBeTruthy();
  });

  it("matches Composio scopes only for services under Add", async () => {
    renderSection([oauth("github", "authorized")], signedIn());
    await screen.findByRole("button", { name: "Open Gmail" });
    fireEvent.change(screen.getByLabelText("Search connections"), {
      target: { value: "your email" },
    });
    expect(screen.queryByRole("button", { name: "Open Gmail" })).toBeNull();
    expect(screen.getByText("No service matches “your email”.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search connections"), { target: { value: "issues" } });
    expect(screen.getByRole("button", { name: "Connect Linear" })).toBeTruthy();
  });

  it("moves a Composio card to Connected after connecting during a name search", async () => {
    const open = rs.spyOn(window, "open").mockReturnValue(null);
    renderSection([oauth("github", "authorized")], signedIn());
    await screen.findByRole("button", { name: "Connect Linear" });
    fireEvent.change(screen.getByLabelText("Search connections"), { target: { value: "linear" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect Linear" }));
    await waitFor(() => expect(open).toHaveBeenCalled());
    linearConnected = true;
    fireEvent(window, new Event("visibilitychange"));
    const row = await screen.findByRole("button", { name: "Open Linear" });
    expect(within(row).getByText("Working")).toBeTruthy();
    expect(within(row).queryByText("Tracks issues and projects.")).toBeNull();
    expect(connectedList().contains(row)).toBe(true);
    fireEvent.click(row);
    expect(
      within(screen.getByRole("dialog")).getByText("Tracks issues and projects."),
    ).toBeTruthy();
  });

  it("keeps an unconnected Composio card busy until connect resolves", async () => {
    const open = rs.spyOn(window, "open").mockReturnValue(null);
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = rs.mocked(globalThis.fetch).getMockImplementation()!;
    rs.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      if (String(input) === "/api/apps/connector/connectors" && init?.method === "POST")
        await pending;
      return fetch(input, init);
    });
    renderSection([oauth("github", "authorized")], signedIn());
    const row = await screen.findByRole("button", { name: "Connect Linear" });
    fireEvent.click(row);
    expect(row.hasAttribute("disabled")).toBe(true);
    release();
    await waitFor(() => expect(open).toHaveBeenCalled());
    await waitFor(() => expect(row.hasAttribute("disabled")).toBe(false));
  });

  it("lists connected Composio services beside Rome's own without route labels, broken ones leading", async () => {
    renderSection([oauth("github", "authorized")], signedIn());
    await screen.findByRole("button", { name: "Open Gmail" });
    const accountsGroup = connectedList();
    const names = within(accountsGroup)
      .getAllByRole("button")
      .map((row) => row.getAttribute("aria-label"));
    // A broken Composio service leads the list like a broken Rome one, and the
    // bridged GitHub account never shows as a Composio row.
    expect(names).toEqual(["Open Notion", "Open GitHub", "Open Composio", "Open Gmail"]);
    const notion = within(accountsGroup).getByRole("button", { name: "Open Notion" });
    expect(within(accountsGroup).queryByText("via Composio")).toBeNull();
    expect(within(notion).getByText("Broken")).toBeTruthy();
    fireEvent.click(notion);
    expect(
      within(screen.getByRole("dialog")).getByText(
        "Rome reaches this service through your Composio account.",
      ),
    ).toBeTruthy();
  });

  it("offers the rest under Add, and starts a connect in a new tab", async () => {
    const open = rs.spyOn(window, "open").mockReturnValue(null);
    renderSection([oauth("github", "authorized")], signedIn());
    await screen.findByRole("button", { name: "Connect Linear" });
    const group = addList();
    expect(within(group).queryByText("Sign in to Composio to connect these services.")).toBeNull();
    fireEvent.click(within(group).getByRole("button", { name: "Connect Linear" }));
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
    const group = addList();
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
    expect(
      within(dialog).getByText("Rome reaches this service through your Composio account."),
    ).toBeTruthy();
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

  it("finds a Composio service by what it does", async () => {
    renderSection([oauth("github", "authorized")], signedIn());
    await screen.findByRole("button", { name: "Connect Linear" });
    fireEvent.change(screen.getByLabelText("Search connections"), {
      target: { value: "issues" },
    });
    expect(screen.getByRole("button", { name: "Connect Linear" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open Google" })).toBeNull();
  });

  it("shows a Composio load failure, with a retry", async () => {
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

  it("opens a connected service in place inside Settings, and Escape returns to its card", async () => {
    const { closed, settings } = renderInSettings([oauth("github", "authorized")], signedIn());
    fireEvent.click(await screen.findByRole("button", { name: "Open Gmail" }));
    expect(within(settings).getByRole("dialog", { name: "Gmail" })).toBeTruthy();
    expect(dialogsOutside(settings)).toEqual([]);
    fireEvent.keyDown(document.activeElement ?? document, { key: "Escape" });
    expect(closed).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(
      within(connectedList()).getByRole("button", { name: "Open Gmail" }),
    );
  });

  it("opens the next service fresh after one vanishes mid-confirmation", async () => {
    renderSection([oauth("github", "authorized")], signedIn());
    fireEvent.click(await screen.findByRole("button", { name: "Open Gmail" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Disconnect" }));
    expect(within(screen.getByRole("dialog")).getByText(/Disconnect Gmail\?/)).toBeTruthy();
    // Gmail is disconnected elsewhere; the refetch on return drops its row,
    // which closes the pane without going through its back button.
    gmailGone = true;
    fireEvent(window, new Event("visibilitychange"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(await screen.findByRole("button", { name: "Open Notion" }));
    expect(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Reconnect" }),
    ).toBeTruthy();
  });
});
