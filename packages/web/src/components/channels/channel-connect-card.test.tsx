// @rstest-environment jsdom
//
// The single generic channel card is driven by CHANNEL_CONFIGS. Every Talk
// channel connects through the generic setup surface
// (`/api/connections/:id/grants/:name/setup` + `/api/setups/:cid/input`); the
// bespoke `/api/channels/*` connect/verify-status routes are gone. These tests
// cover the shared frame once (via Discord) plus the per-service config
// variations, the generic conversation-settings link, and Feishu's registered
// QR renderer.
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    state: "unauthorized",
    display: null,
    identity: null,
    activeSetupCid: null,
  };
}

function connected(grant: string, identity: string | null): ConnectionSlot {
  return {
    key: "bot",
    connectionId: "conn-1",
    grant,
    state: "authorized",
    display: identity
      ? { displayName: null, handle: identity, email: null, avatarUrl: null }
      : null,
    identity,
    activeSetupCid: null,
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
          new Response(
            JSON.stringify({ accepted: true, state: { status: "done", conferral: {} } }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ channels: [], agents: [], apps: [] }), { status: 200 }),
      );
    });
}

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

  it("renders the connected card with @identity, guardian-linked copy, and Disconnect", () => {
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
    expect(screen.getByText("Your Discord account is linked as guardian.")).toBeTruthy();
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

  it("Disconnect DELETEs the slot's grant on the connections registry and refreshes", async () => {
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
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/api/connections/conn-1/grants/bot", {
      method: "DELETE",
    });
  });
});

// ── Per-service config variations ───────────────────────────────────────────

describe("ChannelConnectCard — config variations", () => {
  it("uses the same Connect label for every channel", () => {
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
      expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
      unmount();
    }
  });

  it("shows no guardian note for email when connected", () => {
    stubFetch();
    renderCard(
      <ChannelConnectCard
        config={CHANNEL_CONFIGS.email}
        slot={connected("inbox", "agent@rome.computer")}
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
        slot={{ ...connected("session", null) }}
        role="secondary"
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByText("Telegram user")).toBeTruthy();
  });
});

// ── Registered custom components ─────────────────────────────────────────────

describe("ChannelConnectCard — custom components", () => {
  it("links connected Discord to the generic conversation settings page", () => {
    const fetchMock = stubFetch();
    renderCard(
      <ChannelConnectCard
        config={CHANNEL_CONFIGS.discord}
        slot={connected("bot", "@rome_helper")}
        role="primary"
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByRole("link", { name: "Configure conversations" }).getAttribute("href")).toBe(
      "/settings/channels?connectionId=conn-1",
    );
    expect(fetchMock).not.toHaveBeenCalledWith("/api/channels/discord/channels");
  });

  it("links connected WeChat to the generic conversation settings page", () => {
    stubFetch();
    renderCard(
      <ChannelConnectCard
        config={CHANNEL_CONFIGS.wechat}
        slot={connected("account", "@wechat-user")}
        role="primary"
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByRole("link", { name: "Configure conversations" }).getAttribute("href")).toBe(
      "/settings/channels?connectionId=conn-1",
    );
  });

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
