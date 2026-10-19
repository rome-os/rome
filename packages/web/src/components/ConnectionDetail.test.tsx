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

/** A later account's channel id, opaque as core mints it. */
const SECOND_FEISHU = "c7d1a0e2-5b3f-4e8a-9c61-2f0b7d4e8a13";

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
      [connection({ service: "telegram", grants: { bot: "unauthorized" } })],
      "telegram",
    );
    const { container } = renderBody(telegram);

    // The registry reports no telegram_user connection here, so telegram is
    // single-slot and renders bare: no fallback title (the dialog header
    // already names the service) and no setup subtitle (the ceremony below
    // carries the how-to).
    expect(screen.queryByText("Your Telegram bot")).toBeNull();
    expect(screen.queryByText("Add a bot from @BotFather.")).toBeNull();
    // Unconnected heading + `+` bullets (identity fallback).
    expect(screen.getByText("This connection will let your agent")).toBeTruthy();
    expect(screen.getByText("Reply when people message your bot")).toBeTruthy();
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
          service: "telegram",
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
          service: "telegram",
          grants: { bot: "authorized" },
          display: { bot: grantDisplay({ handle: "@mybot" }) },
        }),
        connection({
          service: "telegram_user",
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
        connection({ service: "telegram", grants: { bot: "unauthorized" } }),
        connection({ service: "telegram_user", grants: { session: "unauthorized" } }),
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
          service: "github",
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
          service: "google",
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
          service: "github",
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
    const webchat = cardFor([connection({ service: "webchat" })], "webchat");
    renderBody(webchat);

    expect(screen.getByText("Chat with your agent right here in the dashboard")).toBeTruthy();
    expect(screen.getByText("Always on — nothing to configure.")).toBeTruthy();
    // The internal Talk/Act/Watch taxonomy is never surfaced.
    expect(screen.queryByText("Talk")).toBeNull();
    expect(screen.queryByText("Capabilities")).toBeNull();
  });

  it("whatsapp: bot-slot card with its bullets and the generic setup entry point", () => {
    const whatsapp = cardFor(
      [connection({ service: "whatsapp", grants: { session: "unauthorized" } })],
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
      [connection({ service: "discord", grants: { bot: "unauthorized" } })],
      "discord",
    );
    renderBody(discord);

    expect(discord.slots.map((slot) => slot.key)).toEqual(["bot"]);
    // Sole slot renders bare — no title echo of the dialog header.
    expect(screen.queryByText("Your Discord bot")).toBeNull();
    expect(screen.getByText("Reply when people message your bot in your servers")).toBeTruthy();
    // The token form is server-authored by the setup — before it
    // starts, the card offers the connect action only.
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
  });

  it("email: bot-slot card with its bullets and the Connect setup", () => {
    const email = cardFor(
      [connection({ service: "email", grants: { inbox: "unauthorized" } })],
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
          service: "telegram",
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
      service: "feishu",
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

  function mockAccountsFetch(linkResponse: unknown, agents: string[] = ["sales:agent"]) {
    const calls: FetchCall[] = [];
    rs.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === "/api/agents") {
        return new Response(JSON.stringify({ agents: agents.map((name) => ({ name })) }), {
          status: 200,
        });
      }
      if (url.startsWith("/api/channels/accounts/") && method === "PUT") {
        return new Response(JSON.stringify(linkResponse), { status: 200 });
      }
      if (url === "/api/connections" && method === "POST") {
        return new Response(
          JSON.stringify({ connection: feishu({ id: "conn-feishu-2", channel: SECOND_FEISHU }) }),
          { status: 201 },
        );
      }
      if (url === "/api/approvals") return new Response("[]", { status: 200 });
      return new Response("{}", { status: 200 });
    });
    return calls;
  }

  function renderAccountBody(
    card: ConnectionCard,
    handlers: {
      onRefresh?: () => void;
      onFlash?: (message: string) => void;
      onOpenAccount?: (route: string) => void;
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

  function linkResult(agent: string | null) {
    return {
      account: {
        id: "feishu",
        service: "feishu",
        platform: "feishu",
        connectionId: "conn-feishu",
        agent,
      },
      unlinkedFrom: null,
    };
  }

  it("links an agent through the PUT, then toasts and refetches", async () => {
    const calls = mockAccountsFetch({
      account: {
        id: "feishu",
        service: "feishu",
        platform: "feishu",
        connectionId: "conn-feishu",
        agent: "sales:agent",
      },
      unlinkedFrom: null,
    });
    const onFlash = rs.fn();
    const onRefresh = rs.fn();
    renderAccountBody(cardFor([feishu()], "feishu"), { onFlash, onRefresh });
    const user = userEvent.setup();

    const picker = screen.getByRole("combobox", { name: "Linked agent" });
    expect(picker.textContent).toContain("None. This account stays silent.");
    await user.click(picker);
    await user.click(await screen.findByRole("option", { name: "sales:agent" }));

    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    expect(calls.find((call) => call.method === "PUT")).toEqual({
      url: "/api/channels/accounts/feishu/agent",
      method: "PUT",
      body: { agent: "sales:agent" },
    });
    expect(toast).toHaveBeenCalledWith("sales:agent now answers on Feishu.");
  });

  it("says the link moved off another account when the server moved it", async () => {
    mockAccountsFetch({
      account: {
        id: SECOND_FEISHU,
        service: "feishu",
        platform: "feishu",
        connectionId: "conn-feishu-2",
        agent: "sales:agent",
      },
      unlinkedFrom: "feishu",
    });
    const onFlash = rs.fn();
    const card = buildConnectionCards([
      feishu(),
      feishu({ id: "conn-feishu-2", channel: SECOND_FEISHU }),
    ]).find((entry) => entry.route === SECOND_FEISHU);
    if (!card) throw new Error("no second Feishu card");
    renderAccountBody(card, { onFlash });
    const user = userEvent.setup();

    await user.click(screen.getByRole("combobox", { name: "Linked agent" }));
    await user.click(await screen.findByRole("option", { name: "sales:agent" }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        "sales:agent now answers on Feishu · Support Bot. Its link to another account on this platform was removed, since an agent other than main links to one account per platform.",
      ),
    );
  });

  it("keeps showing the chosen agent until the refreshed card reports it", async () => {
    mockAccountsFetch({
      account: {
        id: "feishu",
        service: "feishu",
        platform: "feishu",
        connectionId: "conn-feishu",
        agent: "sales:agent",
      },
      unlinkedFrom: null,
    });
    const onRefresh = rs.fn();
    renderAccountBody(cardFor([feishu()], "feishu"), { onRefresh });
    const user = userEvent.setup();

    await user.click(screen.getByRole("combobox", { name: "Linked agent" }));
    await user.click(await screen.findByRole("option", { name: "sales:agent" }));

    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    expect(screen.getByRole("combobox", { name: "Linked agent" }).textContent).toContain(
      "sales:agent",
    );
  });

  it("shows the server's link once it moves off this account after a save", async () => {
    mockAccountsFetch(linkResult("sales:agent"));
    const onRefresh = rs.fn();
    const { rerenderCard } = renderAccountBody(cardFor([feishu()], "feishu"), { onRefresh });
    const user = userEvent.setup();

    await user.click(screen.getByRole("combobox", { name: "Linked agent" }));
    await user.click(await screen.findByRole("option", { name: "sales:agent" }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    rerenderCard(cardFor([feishu({ linkedAgent: "sales:agent" })], "feishu"));
    // Linking sales:agent to another account later moves the link off this one.
    rerenderCard(cardFor([feishu({ linkedAgent: null })], "feishu"));

    expect(screen.getByRole("combobox", { name: "Linked agent" }).textContent).toContain(
      "None. This account stays silent.",
    );
  });

  it("sends None when it is picked before the refreshed card arrives", async () => {
    const calls = mockAccountsFetch(linkResult("sales:agent"));
    const onRefresh = rs.fn();
    renderAccountBody(cardFor([feishu()], "feishu"), { onRefresh });
    const user = userEvent.setup();

    await user.click(screen.getByRole("combobox", { name: "Linked agent" }));
    await user.click(await screen.findByRole("option", { name: "sales:agent" }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    await user.click(screen.getByRole("combobox", { name: "Linked agent" }));
    await user.click(
      await screen.findByRole("option", { name: "None. This account stays silent." }),
    );

    await waitFor(() =>
      expect(calls.filter((call) => call.method === "PUT").map((call) => call.body)).toEqual([
        { agent: "sales:agent" },
        { agent: null },
      ]),
    );
  });

  it("offers main once under its short name and links it by its canonical id", async () => {
    const calls = mockAccountsFetch(linkResult("core:main"), ["core:main", "main", "sales:agent"]);
    const onRefresh = rs.fn();
    renderAccountBody(cardFor([feishu()], "feishu"), { onRefresh });
    const user = userEvent.setup();

    await user.click(screen.getByRole("combobox", { name: "Linked agent" }));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
      "None. This account stays silent.",
      "main",
      "sales:agent",
    ]);
    await user.click(screen.getByRole("option", { name: "main" }));

    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({ agent: "core:main" });
    expect(toast).toHaveBeenCalledWith("main now answers on Feishu.");
  });

  it("shows main once when the server reports it by its short name", async () => {
    mockAccountsFetch(linkResult("core:main"), ["core:main", "sales:agent"]);
    renderAccountBody(cardFor([feishu({ linkedAgent: "main" })], "feishu"));
    const user = userEvent.setup();

    const picker = screen.getByRole("combobox", { name: "Linked agent" });
    expect(picker.textContent).toContain("main");
    await user.click(picker);
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
      "None. This account stays silent.",
      "main",
      "sales:agent",
    ]);
  });

  it("says the agents could not load instead of offering only None", async () => {
    rs.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input) === "/api/agents") return new Response("", { status: 500 });
      if (String(input) === "/api/approvals") return new Response("[]", { status: 200 });
      return new Response("{}", { status: 200 });
    });
    renderAccountBody(cardFor([feishu()], "feishu"));

    expect((await screen.findByRole("alert")).textContent).toBe("Could not load agents");
  });

  it("clears the link with None", async () => {
    const calls = mockAccountsFetch({
      account: {
        id: "feishu",
        service: "feishu",
        platform: "feishu",
        connectionId: "conn-feishu",
        agent: null,
      },
      unlinkedFrom: null,
    });
    const onFlash = rs.fn();
    renderAccountBody(cardFor([feishu({ linkedAgent: "sales:agent" })], "feishu"), { onFlash });
    const user = userEvent.setup();

    const picker = screen.getByRole("combobox", { name: "Linked agent" });
    expect(picker.textContent).toContain("sales:agent");
    await user.click(picker);
    await user.click(
      await screen.findByRole("option", { name: "None. This account stays silent." }),
    );

    await waitFor(() => expect(toast).toHaveBeenCalledWith("Feishu now stays silent."));
    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({ agent: null });
  });

  it("hides the picker until the server reports links", () => {
    mockAccountsFetch(null);
    const { linkedAgent: _omitted, ...older } = feishu();
    renderAccountBody(cardFor([older], "feishu"), { onOpenAccount: rs.fn() });
    expect(screen.queryByRole("combobox", { name: "Linked agent" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add another account" })).toBeTruthy();
  });

  it("adds another account and opens it by its route", async () => {
    const calls = mockAccountsFetch(null);
    const onOpenAccount = rs.fn();
    renderAccountBody(cardFor([feishu()], "feishu"), { onOpenAccount });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Add another account" }));

    await waitFor(() => expect(onOpenAccount).toHaveBeenCalledWith(SECOND_FEISHU));
    expect(calls.find((call) => call.method === "POST")).toEqual({
      url: "/api/connections",
      method: "POST",
      body: { service: "feishu" },
    });
  });

  it("says the account was added when it cannot be opened yet", async () => {
    mockAccountsFetch();
    const onFlash = rs.fn();
    const onOpenAccount = rs.fn(async () => {
      throw new Error("not listed");
    });
    renderAccountBody(cardFor([feishu()], "feishu"), { onFlash, onOpenAccount });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Add another account" }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("Account added. Find it in the Connections list."),
    );
    expect(onFlash).not.toHaveBeenCalledWith("Could not add an account");
  });

  it("does not open the first account when the new one comes back without a channel", async () => {
    rs.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input) === "/api/connections" && init?.method === "POST") {
        return new Response(JSON.stringify({ connection: feishu({ channel: null }) }), {
          status: 201,
        });
      }
      return new Response("{}", { status: 200 });
    });
    const onFlash = rs.fn();
    const onOpenAccount = rs.fn();
    renderAccountBody(cardFor([feishu()], "feishu"), { onFlash, onOpenAccount });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Add another account" }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("Account added. Find it in the Connections list."),
    );
    expect(onOpenAccount).not.toHaveBeenCalled();
  });

  it("reports a failed add with the localized fallback", async () => {
    rs.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input) === "/api/connections" && init?.method === "POST") {
        return new Response("", { status: 500 });
      }
      return new Response("{}", { status: 200 });
    });
    const onFlash = rs.fn();
    const onOpenAccount = rs.fn();
    renderAccountBody(cardFor([feishu()], "feishu"), { onFlash, onOpenAccount });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Add another account" }));

    await waitFor(() => expect(onFlash).toHaveBeenCalledWith("Could not add an account"));
    expect(onOpenAccount).not.toHaveBeenCalled();
  });

  it("hides the account controls until the Talk is connected", () => {
    renderAccountBody(cardFor([feishu({ grants: { app: "unauthorized" } })], "feishu"), {
      onOpenAccount: rs.fn(),
    });
    expect(screen.queryByRole("combobox", { name: "Linked agent" })).toBeNull();
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
