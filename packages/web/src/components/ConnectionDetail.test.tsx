// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "@/i18n";
import { ConnectionDetailBody } from "@/components/ConnectionDetail";
import { buildConnectionCards, type ConnectionCard } from "@/lib/connection-cards";
import type { ApiConnection, ConnectHint, GrantDisplay, GrantState } from "@/lib/connections-api";
import type { ComposioCliStatus } from "@/lib/provider-types";

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
