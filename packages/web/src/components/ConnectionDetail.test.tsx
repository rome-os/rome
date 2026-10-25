// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "@/i18n";
import { ConnectionDetailBody } from "@/components/ConnectionDetail";
import { buildConnectionCards, type ConnectionCard } from "@/lib/connection-cards";
import type { ApiConnection, ConnectHint, GrantDisplay, GrantState } from "@/lib/connections-api";
import type { ComposioCliStatus } from "@/lib/provider-types";
import { toast } from "sonner";

rs.mock("sonner", () => ({
  toast: Object.assign(
    rs.fn(() => "toast-id"),
    {
      success: rs.fn(),
      error: rs.fn(),
      dismiss: rs.fn(),
    },
  ),
}));

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  // The ceremony cards self-fetch their transient status on mount
  // (verify-status polls, telegram user/status). Default them all to minimal
  // ok JSON; tests that assert ceremony-fed identity override via
  // mockCeremonyFetch.
  mockCeremonyFetch();
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function mockCeremonyFetch(routes: Record<string, unknown> = {}) {
  rs.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url === "/api/approvals") return new Response("[]", { status: 200 });
    for (const [needle, payload] of Object.entries(routes)) {
      if (url.includes(needle)) {
        return new Response(JSON.stringify(payload), { status: 200 });
      }
    }
    return new Response("{}", { status: 200 });
  });
}

function grantDisplay(overrides: Partial<GrantDisplay> = {}): GrantDisplay {
  return { displayName: null, handle: null, email: null, avatarUrl: null, ...overrides };
}

function connection(
  overrides: Partial<ApiConnection> & Pick<ApiConnection, "connectionKind">,
): ApiConnection {
  return {
    id: `conn-${overrides.connectionKind}`,
    label: overrides.connectionKind,
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
    agent: null,
    severalAccounts: false,
    ...overrides,
  };
}

function oauthConnect(service: string): ConnectHint {
  return { url: `https://oauth/${service}`, available: true, unavailableReason: null };
}

function cardFor(connections: ApiConnection[], service: string): ConnectionCard {
  const card = buildConnectionCards(connections).find((entry) => entry.service === service);
  if (!card) throw new Error(`no card for service ${service}`);
  return card;
}

function renderBody(card: ConnectionCard, composio: ComposioCliStatus | null = null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ConnectionDetailBody
          card={card}
          composio={composio}
          onRefresh={() => {}}
          onFlash={() => {}}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ConnectionDetailBody — Telegram reference (bot slot)", () => {
  it("unconnected bot: bare sole slot with subtitle lead, + bullets under the primary heading, and the token ceremony", () => {
    const telegram = cardFor(
      [connection({ connectionKind: "telegram", grants: { bot: "unauthorized" } })],
      "telegram",
    );
    const { container } = renderBody(telegram);

    // The registry reports no telegram_user connection here, so telegram is
    // single-slot and renders bare: no fallback title (the dialog header
    // already names the service) and no setup subtitle (the ceremony below
    // carries the how-to).
    expect(screen.queryByText("Your agent's Telegram account")).toBeNull();
    expect(screen.queryByText("Create the account with @BotFather.")).toBeNull();
    // Unconnected heading + `+` bullets (identity fallback).
    expect(screen.getByText("This connection will let your agent")).toBeTruthy();
    expect(screen.getByText("Reply when people message this account")).toBeTruthy();
    expect(screen.getByText("Start a task when a new message arrives")).toBeTruthy();
    // Bare sole slot: no inner card box.
    const card = container.querySelector("section");
    expect(card?.className).not.toContain("border");
    // The bot slot runs the generic setup: the unconnected
    // card offers a single Connect action that starts the setup coroutine — the
    // bespoke Bot Token field + "Setup steps" accordion are gone.
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
    expect(screen.queryByText("Bot Token")).toBeNull();
    expect(screen.queryByRole("button", { name: /Setup steps/i })).toBeNull();
  });

  it("connected bot: identity header + Disconnect + ✓ bullets that interpolate the bot username", () => {
    const telegram = cardFor(
      [
        connection({
          connectionKind: "telegram",
          grants: { bot: "authorized" },
          display: { bot: grantDisplay({ handle: "@fujian_helper_bot" }) },
        }),
      ],
      "telegram",
    );
    const { container } = renderBody(telegram);

    // Identity is the card title.
    expect(screen.getByText("@fujian_helper_bot")).toBeTruthy();
    // Connected heading + ✓ bullets, with the interpolated identity.
    expect(screen.getByText("This connection lets your agent")).toBeTruthy();
    expect(screen.getByText("Reply when people message @fujian_helper_bot")).toBeTruthy();
    // Disconnect action in the header.
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
    // Solid (non-dashed) border once connected.
    const card = container.querySelector("section");
    expect(card?.className).not.toContain("border-dashed");
  });
});

describe("ConnectionDetailBody — Telegram reference (personal-account slot)", () => {
  function withSession(
    sessionState: GrantState,
    sessionDisplay?: Partial<GrantDisplay>,
  ): ConnectionCard {
    return cardFor(
      [
        connection({
          connectionKind: "telegram",
          grants: { bot: "authorized" },
          display: { bot: grantDisplay({ handle: "@mybot" }) },
        }),
        connection({
          connectionKind: "telegram_user",
          grants: { session: sessionState },
          ...(sessionDisplay ? { display: { session: grantDisplay(sessionDisplay) } } : {}),
        }),
      ],
      "telegram",
    );
  }

  it("keeps the personal-account slot secondary when neither Telegram slot is connected", () => {
    const telegram = cardFor(
      [
        connection({ connectionKind: "telegram", grants: { bot: "unauthorized" } }),
        connection({ connectionKind: "telegram_user", grants: { session: "unauthorized" } }),
      ],
      "telegram",
    );
    renderBody(telegram);

    const [botConnect, accountConnect] = screen.getAllByRole("button", { name: "Connect" });
    expect(botConnect.getAttribute("data-variant")).toBe("default");
    expect(botConnect.getAttribute("data-size")).toBe("md");

    expect(accountConnect.getAttribute("data-variant")).toBe("outline");
    expect(accountConnect.getAttribute("data-size")).toBe("sm");
    expect(screen.getByText("Available to add")).toBeTruthy();
    expect(screen.getByText("Adding it lets your agent also")).toBeTruthy();
  });

  it('unconnected session: an "Available to add" dashed card with the secondary heading, + bullets, privacy note, and the generic setup entry point', () => {
    renderBody(withSession("unauthorized"));

    // The "Available to add" section label appears above the secondary slot.
    expect(screen.getByText("Available to add")).toBeTruthy();
    // Static title + subtitle.
    expect(screen.getByText("Your account")).toBeTruthy();
    expect(screen.getByText("Sign in with your phone number.")).toBeTruthy();
    // Secondary heading (it's an add-on to the already-connected bot).
    expect(screen.getByText("Adding it lets your agent also")).toBeTruthy();
    expect(
      screen.getByText("Send messages from your account — reach suppliers and customers as you"),
    ).toBeTruthy();
    // The lock privacy note.
    expect(
      screen.getByText(
        "Encrypted, stored only on your instance, visible in Telegram's active sessions. Disconnect anytime.",
      ),
    ).toBeTruthy();
    // The phone-code/2FA form is server-authored by the setup — before
    // it starts, the card offers the generic Connect entry point.
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
  });

  it("connected session: the account name is the title with a Disconnect, and ✓ bullets", () => {
    // The account identity is the grant profile's folded display (with no
    // bespoke status route); the login secrets never cross to the client.
    renderBody(withSession("authorized", { displayName: "Ada" }));

    expect(screen.getByText("Ada")).toBeTruthy();
    // Two Disconnect buttons now (bot + session); the session card shows ✓ bullets.
    expect(screen.getAllByRole("button", { name: "Disconnect" }).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Read and summarize your chats and groups")).toBeTruthy();
    // No "Available to add" label — the slot is connected, not addable.
    expect(screen.queryByText("Available to add")).toBeNull();
  });
});

describe("ConnectionDetailBody — OAuth single-slot cards", () => {
  it("github (unconnected): + bullets incl. the watch bullet, privacy note, and the Continue ceremony", () => {
    const github = cardFor(
      [
        connection({
          connectionKind: "github",
          grants: { user: "unauthorized" },
          connect: oauthConnect("github"),
        }),
      ],
      "github",
    );
    renderBody(github);

    // Sole slot renders bare — no title echo of the dialog header.
    expect(screen.queryByText("Your GitHub account")).toBeNull();
    expect(screen.getByText("This connection will let your agent")).toBeTruthy();
    expect(
      screen.getByText(
        "Work with your repositories, issues, pull requests, and project boards as you",
      ),
    ).toBeTruthy();
    // The watch bullet is github-only.
    expect(screen.getByText("React when something happens in your repositories")).toBeTruthy();
    // OAuth privacy note.
    expect(
      screen.getByText("You approve access on GitHub; you can disconnect here anytime."),
    ).toBeTruthy();
    expect(screen.getByText("Connect")).toBeTruthy();
  });

  it("google (unconnected): no watch bullet for a non-allowlisted service", () => {
    const google = cardFor(
      [
        connection({
          connectionKind: "google",
          grants: { user: "unauthorized" },
          connect: oauthConnect("google"),
        }),
      ],
      "google",
    );
    renderBody(google);

    expect(screen.getByText("Work across your Google services as you")).toBeTruthy();
    expect(screen.queryByText("React when something happens in your repositories")).toBeNull();
  });

  it("github (connected): ✓ bullets, the account identity + email, and Reconnect + Disconnect", () => {
    const github = cardFor(
      [
        connection({
          connectionKind: "github",
          grants: { user: "authorized" },
          display: {
            user: grantDisplay({ displayName: "Ada Lovelace", email: "ada@example.com" }),
          },
          connect: oauthConnect("github"),
        }),
      ],
      "github",
    );
    renderBody(github);

    expect(screen.getByText("This connection lets your agent")).toBeTruthy();
    // The connected identity is the card title; the email is the connected
    // subtitle (it adds information beyond the title).
    expect(screen.getAllByText("Ada Lovelace").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("ada@example.com")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
  });
});

describe("ConnectionDetailBody — webchat and remaining channels", () => {
  it("always-on webchat: connected card with its chat bullet and the nothing-to-configure note", () => {
    const webchat = cardFor([connection({ connectionKind: "webchat" })], "webchat");
    renderBody(webchat);

    expect(screen.getByText("Chat with your agent right here in the dashboard")).toBeTruthy();
    expect(screen.getByText("Always on — nothing to configure.")).toBeTruthy();
    // The internal Talk/Act/Watch taxonomy is never surfaced.
    expect(screen.queryByText("Talk")).toBeNull();
    expect(screen.queryByText("Capabilities")).toBeNull();
  });

  it("whatsapp: bot-slot card with its bullets and the generic setup entry point", () => {
    const whatsapp = cardFor(
      [connection({ connectionKind: "whatsapp", grants: { session: "unauthorized" } })],
      "whatsapp",
    );
    renderBody(whatsapp);

    // Sole slot renders bare — no title echo of the dialog header.
    expect(screen.queryByText("Your WhatsApp")).toBeNull();
    expect(screen.getByText("Reply when people message you on WhatsApp")).toBeTruthy();
    // The setup replaces the bespoke QR/pairing ceremony: the card
    // offers the generic Connect entry point until a setup is started.
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
  });

  it("discord: single bot-slot card, bullets, and the setup connect action", () => {
    const discord = cardFor(
      [connection({ connectionKind: "discord", grants: { bot: "unauthorized" } })],
      "discord",
    );
    renderBody(discord);

    expect(discord.slots.map((slot) => slot.key)).toEqual(["bot"]);
    // Sole slot renders bare — no title echo of the dialog header.
    expect(screen.queryByText("Your agent's Discord account")).toBeNull();
    expect(screen.getByText("Reply when people message this account in your servers")).toBeTruthy();
    // The token form is server-authored by the setup — before it
    // starts, the card offers the connect action only.
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
  });

  it("email: bot-slot card with its bullets and the Connect setup", () => {
    const email = cardFor(
      [connection({ connectionKind: "email", grants: { inbox: "unauthorized" } })],
      "email",
    );
    renderBody(email);

    expect(screen.getByText("Email your agent and it replies")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
  });

  it("does not render the same enablement bullet twice in a dialog", () => {
    const telegram = cardFor(
      [
        connection({
          connectionKind: "telegram",
          grants: { bot: "authorized" },
          display: { bot: grantDisplay({ handle: "@mybot" }) },
        }),
      ],
      "telegram",
    );
    const { container } = renderBody(telegram);

    const bullet = "Reply when people message @mybot";
    expect(within(container).getAllByText(bullet)).toHaveLength(1);
  });
});

describe("ConnectionDetailBody — accounts", () => {
  function feishu(overrides: Partial<ApiConnection> = {}): ApiConnection {
    return connection({
      connectionKind: "feishu",
      channel: "feishu",
      grants: { app: "authorized" },
      display: { app: grantDisplay({ displayName: "Support Bot" }) },
      capabilities: {
        talk: { state: "unlocked" },
        act: { state: "unsupported" },
        watch: { state: "unsupported" },
      },
      severalAccounts: true,
      ...overrides,
    });
  }

  type FetchCall = { url: string; method: string; body: unknown };

  function renderAccountBody(
    card: ConnectionCard,
    handlers: {
      onRefresh?: () => void;
      onFlash?: (message: string) => void;
      onOpenAccount?: (connectionId: string) => void;
    } = {},
  ) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (shown: ConnectionCard) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ConnectionDetailBody
            card={shown}
            composio={null}
            onRefresh={handlers.onRefresh ?? (() => {})}
            onFlash={handlers.onFlash ?? (() => {})}
            onOpenAccount={handlers.onOpenAccount}
          />
        </MemoryRouter>
      </QueryClientProvider>
    );
    const result = render(tree(card));
    return { ...result, rerenderCard: (next: ConnectionCard) => result.rerender(tree(next)) };
  }

  it("shows the account's agent and sends changes to its Envoys settings", () => {
    renderAccountBody(cardFor([feishu({ agent: "sales:agent" })], "feishu"));

    expect(screen.getByText("sales:agent")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByRole("link", { name: /Change in Envoys/ }).getAttribute("href")).toBe(
      `/envoys/${encodeURIComponent("sales:agent")}/settings`,
    );
  });

  it("shows main by its short name", () => {
    renderAccountBody(cardFor([feishu({ agent: "main" })], "feishu"));

    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Change in Envoys/ }).getAttribute("href")).toBe(
      `/envoys/${encodeURIComponent("core:main")}/settings`,
    );
  });

  it("sends an account with no agent to the Envoys list", () => {
    renderAccountBody(cardFor([feishu()], "feishu"));

    expect(screen.getByText("No agent")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Change in Envoys/ }).getAttribute("href")).toBe(
      "/envoys",
    );
  });

  it("hides the agent until the server reports links", () => {
    const { agent: _omitted, ...older } = feishu();
    renderAccountBody(cardFor([older], "feishu"), { onOpenAccount: rs.fn() });
    expect(screen.queryByRole("link", { name: /Change in Envoys/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Add another account" })).toBeTruthy();
  });

  /** Answer the new account's setup start as connected at once, naming
   *  `connectionId` when given, and record each call. */
  function mockNewAccountSetup(connectionId?: string) {
    const calls: FetchCall[] = [];
    rs.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith("/setup") && method === "POST") {
        const conferral = connectionId ? { connectionId } : {};
        return new Response(
          JSON.stringify({
            cid: "cid-new",
            state: { status: "done", conferral },
            reattached: false,
          }),
          { status: 200 },
        );
      }
      if (url === "/api/approvals") return new Response("[]", { status: 200 });
      return new Response("{}", { status: 200 });
    });
    return calls;
  }

  it("opens the connect flow for a new account, and creates nothing until it connects", async () => {
    const calls = mockNewAccountSetup("conn-feishu-2");
    const onRefresh = rs.fn();
    const onOpenAccount = rs.fn();
    renderAccountBody(cardFor([feishu()], "feishu"), { onRefresh, onOpenAccount });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Add another account" }));
    expect(screen.getByText("New account")).toBeTruthy();
    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(onOpenAccount).toHaveBeenCalledWith("conn-feishu-2"));
    // Opening the account refetches, so the card does not refresh first.
    expect(onRefresh).not.toHaveBeenCalled();
    expect(calls.filter((call) => call.method === "POST")).toEqual([
      {
        url: "/api/connections/feishu/grants/app/setup",
        method: "POST",
        body: { force: false, another: true },
      },
    ]);
  });

  it("says the account was connected when it cannot be opened yet", async () => {
    mockNewAccountSetup("conn-feishu-2");
    const onOpenAccount = rs.fn(async () => {
      throw new Error("not listed");
    });
    renderAccountBody(cardFor([feishu()], "feishu"), { onOpenAccount });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Add another account" }));
    await user.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("Account connected. Find it in the Connections list."),
    );
  });

  it("does not open an account when core does not name the one it connected", async () => {
    mockNewAccountSetup();
    const onRefresh = rs.fn();
    const onOpenAccount = rs.fn();
    renderAccountBody(cardFor([feishu()], "feishu"), { onRefresh, onOpenAccount });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Add another account" }));
    await user.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("Account connected. Find it in the Connections list."),
    );
    expect(onOpenAccount).not.toHaveBeenCalled();
    expect(onRefresh).toHaveBeenCalled();
  });

  it("closes the new account's connect flow on Cancel", async () => {
    mockNewAccountSetup();
    renderAccountBody(cardFor([feishu()], "feishu"), { onOpenAccount: rs.fn() });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Add another account" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText("New account")).toBeNull();
    expect(screen.getByRole("button", { name: "Add another account" })).toBeTruthy();
  });

  it("hides the account controls until the Talk is connected", () => {
    renderAccountBody(cardFor([feishu({ grants: { app: "unauthorized" } })], "feishu"), {
      onOpenAccount: rs.fn(),
    });
    expect(screen.queryByRole("link", { name: /Change in Envoys/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add another account" })).toBeNull();
  });

  it("offers no second account when the server omits severalAccounts", () => {
    const { severalAccounts: _omitted, ...older } = feishu();
    renderAccountBody(cardFor([older], "feishu"), { onOpenAccount: rs.fn() });
    expect(screen.queryByRole("button", { name: "Add another account" })).toBeNull();
  });

  it("offers no second account for a service that holds one", () => {
    renderAccountBody(cardFor([feishu({ severalAccounts: false })], "feishu"), {
      onOpenAccount: rs.fn(),
    });
    expect(screen.queryByRole("button", { name: "Add another account" })).toBeNull();
  });
});
