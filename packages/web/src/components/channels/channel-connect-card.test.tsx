// @rstest-environment jsdom
//
// The single generic channel card is driven by CHANNEL_CONFIGS. Every Talk
// channel connects through the generic setup surface
// (`/api/connections/:id/grants/:name/setup` + `/api/setups/:cid/input`); the
// bespoke `/api/channels/*` connect/verify-status routes are gone. These tests
// cover the shared frame once (via Discord) plus the per-service config
// variations, the generic chat settings link, and Feishu's registered
// QR renderer.
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import i18n from "@/i18n";
import { CHANNEL_CONFIGS, ChannelConnectCard } from "@/components/channels/channel-connect-card";
import type { ConnectionSlot } from "@/lib/connection-cards";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function unconnected(grant: string): ConnectionSlot {
  return {
    key: "bot",
    connectionId: null,
    grant,
    state: null,
    display: null,
    identity: null,
    activeSetupCid: null,
    link: "own_account",
  };
}

function connected(grant: string, identity: string | null): ConnectionSlot {
  return {
    key: "bot",
    connectionId: "conn-1",
    grant,
    state: "working",
    display: identity
      ? { displayName: null, handle: identity, email: null, avatarUrl: null }
      : null,
    identity,
    activeSetupCid: null,
    link: "own_account",
  };
}

function renderCard(element: ReactElement) {
  return render(<MemoryRouter>{element}</MemoryRouter>);
}

const AWAITING_INPUT = {
  cid: "cid-1",
  reattached: false,
  state: {
    status: "awaiting-input",
    form: {
      instructions: "Paste the bot token from the Discord Developer Portal.",
      fields: [{ name: "token", label: "Discord bot token", secret: true }],
    },
  },
};

/** Route the fetch mock by URL: setup start/input, grant revoke, and the
 *  auxiliary endpoints DiscordChannelRouting hits on mount (all empty). */
function stubFetch(overrides: (url: string, init?: RequestInit) => Response | null = () => null) {
  return rs
    .spyOn(globalThis, "fetch")
    .mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const custom = overrides(url, init);
      if (custom) return Promise.resolve(custom);
      if (init?.method === "DELETE") return Promise.resolve(new Response("{}", { status: 200 }));
      if (url.endsWith("/setup")) {
        return Promise.resolve(new Response(JSON.stringify(AWAITING_INPUT), { status: 200 }));
      }
      if (url.includes("/api/setups/") && url.endsWith("/input")) {
        return Promise.resolve(
          new Response(JSON.stringify({ accepted: true, state: { status: "done", grant: {} } }), {
            status: 200,
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ channels: [], agents: [], apps: [] }), { status: 200 }),
      );
    });
}

it.each([
  "telegram",
  "discord",
  "feishu",
])("%s connection alone does not claim the guardian is paired", (service) => {
  stubFetch();
  const config = CHANNEL_CONFIGS[service];
  renderCard(
    <ChannelConnectCard
      config={config}
      slot={connected(config.defaultGrant, "Rome Bot")}
      role="primary"
      onRefresh={() => {}}
    />,
  );
  expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
  expect(screen.queryByText(/linked as guardian/)).toBeNull();
});

it("renews a degraded account in place instead of only offering Disconnect", async () => {
  const fetchMock = stubFetch();
  renderCard(
    <ChannelConnectCard
      config={CHANNEL_CONFIGS.discord}
      slot={{ ...connected("bot", "@rome_helper"), state: "broken" }}
      role="primary"
      onRefresh={() => {}}
    />,
  );
  expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));

  await waitFor(() => expect(screen.getByLabelText("Discord bot token")).toBeTruthy());
  expect(
    fetchMock.mock.calls.some(([url]) =>
      String(url).includes("/connections/conn-1/grants/bot/setup"),
    ),
  ).toBe(true);
});

it("offers Reconnect again when a renewed account degrades a second time", async () => {
  stubFetch();
  const degraded = { ...connected("bot", "@rome_helper"), state: "broken" as const };
  const card = (slot: ConnectionSlot) => (
    <MemoryRouter>
      <ChannelConnectCard
        config={CHANNEL_CONFIGS.discord}
        slot={slot}
        role="primary"
        onRefresh={() => {}}
      />
    </MemoryRouter>
  );
  const { rerender } = render(card(degraded));

  fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
  const token = await screen.findByLabelText("Discord bot token");
  fireEvent.change(token, { target: { value: "new-token" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(screen.queryByLabelText("Discord bot token")).toBeNull());

  rerender(card(connected("bot", "@rome_helper")));
  rerender(card(degraded));

  expect(await screen.findByRole("button", { name: "Reconnect" })).toBeTruthy();
});

// ── Shared frame (via Discord) ──────────────────────────────────────────────

describe("ChannelConnectCard — shared frame", () => {
  it("renders the unconnected card with the connect action and no Disconnect", () => {
    stubFetch();
    renderCard(
      <ChannelConnectCard
        config={CHANNEL_CONFIGS.discord}
        slot={unconnected("bot")}
        role="primary"
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
  });

  it("renders the connected card with @identity and Disconnect", () => {
    stubFetch();
    renderCard(
      <ChannelConnectCard
        config={CHANNEL_CONFIGS.discord}
        slot={connected("bot", "@rome_helper")}
        role="primary"
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByText("@rome_helper")).toBeTruthy();
    expect(screen.queryByText(/linked as guardian/)).toBeNull();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
  });

  it("starts the setup through the generic route, then submits the pasted token", async () => {
    const fetchMock = stubFetch();
    const onRefresh = rs.fn();
    renderCard(
      <ChannelConnectCard
        config={CHANNEL_CONFIGS.discord}
        slot={unconnected("bot")}
        role="primary"
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    // The generic start route was hit (never the bespoke /api/channels/connect).
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/connections/discord/grants/bot/setup",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(fetchMock).not.toHaveBeenCalledWith("/api/channels/connect", expect.anything());

    const field = await screen.findByLabelText("Discord bot token");
    fireEvent.change(field, { target: { value: "bot-token-123" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/setups/cid-1/input",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
  });

  it("re-attaches to a discovered live setup by polling its state", async () => {
    const fetchMock = stubFetch((url) =>
      url === "/api/setups/live-cid"
        ? new Response(
            JSON.stringify({
              state: { status: "presenting", view: { title: "Link your account" } },
            }),
            { status: 200 },
          )
        : null,
    );
    renderCard(
      <ChannelConnectCard
        config={CHANNEL_CONFIGS.discord}
        slot={{ ...unconnected("bot"), activeSetupCid: "live-cid" }}
        role="primary"
        onRefresh={() => {}}
      />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/setups/live-cid"));
  });

  it("Disconnect asks first, then DELETEs the slot's grant and refreshes", async () => {
    const fetchMock = stubFetch();
    const onRefresh = rs.fn();
    renderCard(
      <ChannelConnectCard
        config={CHANNEL_CONFIGS.discord}
        slot={connected("bot", "@rome_helper")}
        role="primary"
        onRefresh={onRefresh}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(screen.getByText("Disconnect @rome_helper?")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);

    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/api/connections/conn-1/grants/bot", {
      method: "DELETE",
    });
  });
});

// ── Per-service config variations ───────────────────────────────────────────

describe("ChannelConnectCard — config variations", () => {
  it("uses the same Connect label for every channel but one that names its own", () => {
    stubFetch();
    for (const cfg of Object.values(CHANNEL_CONFIGS)) {
      const { unmount } = renderCard(
        <ChannelConnectCard
          config={cfg}
          slot={unconnected(cfg.defaultGrant)}
          role="primary"
          onRefresh={() => {}}
        />,
      );
      const label = cfg.connectLabelKey ? "Link Discord" : "Connect";
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
      unmount();
    }
  });

  it("disconnects an account of a kind that takes no agent without asking", async () => {
    const fetchMock = stubFetch();
    renderCard(
      <ChannelConnectCard
        config={CHANNEL_CONFIGS.email}
        slot={{ ...connected("inbox", "agent@rome.computer"), link: null }}
        role="primary"
        onRefresh={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true),
    );
  });

  it("shows no guardian note for email when connected", () => {
    stubFetch();
    renderCard(
      <ChannelConnectCard
        config={CHANNEL_CONFIGS.email}
        slot={{ ...connected("inbox", "agent@rome.computer"), link: null }}
        role="primary"
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByText("agent@rome.computer")).toBeTruthy();
    expect(screen.queryByText(/linked as guardian/i)).toBeNull();
  });

  it("falls back to the telegram-user name when connected without a folded identity", () => {
    stubFetch();
    renderCard(
      <ChannelConnectCard
        config={CHANNEL_CONFIGS.telegram_user}
        slot={{ ...connected("session", null), link: "delegate" }}
        role="secondary"
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByText("Telegram user")).toBeTruthy();
  });
});

// ── Registered custom components ─────────────────────────────────────────────

describe("ChannelConnectCard — custom components", () => {
  it("renders the Feishu QR image from the presenting payload's data-url link", async () => {
    stubFetch((url) =>
      url === "/api/setups/feishu-cid"
        ? new Response(
            JSON.stringify({
              state: {
                status: "presenting",
                view: {
                  title: "Scan to authorize",
                  links: [{ label: "Feishu QR", url: "data:image/png;base64,QQ==" }],
                },
              },
            }),
            { status: 200 },
          )
        : null,
    );
    renderCard(
      <ChannelConnectCard
        config={CHANNEL_CONFIGS.feishu}
        slot={{ ...unconnected("app"), activeSetupCid: "feishu-cid" }}
        role="primary"
        onRefresh={() => {}}
      />,
    );
    const img = (await screen.findByAltText("Feishu QR")) as HTMLImageElement;
    expect(img.src).toBe("data:image/png;base64,QQ==");
  });
});

describe("Link Discord: one click connects and opens Discord's page", () => {
  const INSTALL = "https://discord.com/oauth2/authorize?x=1";
  const ended = (status: "done" | "failed") =>
    new Response(
      JSON.stringify({
        cid: `cid-${status}`,
        reattached: false,
        state:
          status === "done"
            ? { status, grant: {} }
            : { status, reason: "Not linked to Rome Cloud." },
      }),
      { status: 200 },
    );
  /** Answers the setup start with each of `starts` in turn, and the install link with `link`. */
  function stubLink(starts: Array<"done" | "failed">, link: () => Response) {
    const queue = [...starts];
    return stubFetch((url) => {
      if (url.endsWith("/setup")) return ended(queue.shift() ?? "done");
      if (url === "/api/connections/discord-app/install-link") return link();
      return null;
    });
  }
  const tabStub = () => ({ opener: {}, location: { href: "" }, close: rs.fn() });
  const card = (onRefresh = () => {}) =>
    renderCard(
      <ChannelConnectCard
        config={CHANNEL_CONFIGS.discord_app}
        slot={unconnected("bot")}
        role="primary"
        onRefresh={onRefresh}
      />,
    );

  afterEach(() => {
    delete window.rome;
  });

  it("sends the tab opened in the click to Discord once connected", async () => {
    stubLink(["done"], () => Response.json({ url: INSTALL }));
    const tab = tabStub();
    const open = rs.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    card();
    fireEvent.click(screen.getByRole("button", { name: "Link Discord" }));
    expect(open).toHaveBeenCalledWith("", "_blank");
    await waitFor(() => expect(tab.location.href).toBe(INSTALL));
    expect(tab.opener).toBeNull();
  });

  it("hands Discord's page to the system browser in the Mac app, which gives no tab", async () => {
    window.rome = {};
    stubLink(["done"], () => Response.json({ url: INSTALL }));
    const open = rs.spyOn(window, "open").mockReturnValue(null);
    card();
    fireEvent.click(screen.getByRole("button", { name: "Link Discord" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith(INSTALL));
    expect(open).not.toHaveBeenCalledWith("", "_blank");
  });

  it("closes the tab when connecting fails, and opens Discord after a Retry that works", async () => {
    stubLink(["failed", "done"], () => Response.json({ url: INSTALL }));
    const first = tabStub();
    const second = tabStub();
    rs.spyOn(window, "open")
      .mockReturnValueOnce(first as unknown as Window)
      .mockReturnValueOnce(second as unknown as Window);
    card();
    fireEvent.click(screen.getByRole("button", { name: "Link Discord" }));
    await waitFor(() => expect(first.close).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(second.location.href).toBe(INSTALL));
  });

  it("says so when there is no link to open, and closes the tab", async () => {
    stubLink(["done"], () => new Response(null, { status: 502 }));
    const tab = tabStub();
    rs.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    card();
    fireEvent.click(screen.getByRole("button", { name: "Link Discord" }));
    expect(await screen.findByText("Couldn't open Discord. Try again.")).toBeTruthy();
    expect(tab.close).toHaveBeenCalled();
  });
});
