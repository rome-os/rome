import { describe, expect, it } from "@rstest/core";
import { buildConnectionCards } from "@/lib/connection-cards";
import type { ApiConnection, GrantDisplay } from "@/lib/connections-api";
import type { ComposioCliStatus } from "@/lib/provider-types";

/**
 * The presentation fold over `GET /api/connections`: one card per service,
 * registry grant states verbatim on the slots, plus the two brand quirks —
 * the Telegram personal account (`telegram_user` service) folds onto the
 * Telegram card as its `session` slot, and the Composio broker appends as a
 * synthetic card when (and only when) its CLI is installed.
 */

function display(overrides: Partial<GrantDisplay> = {}): GrantDisplay {
  return { displayName: null, handle: null, email: null, avatarUrl: null, ...overrides };
}

function conn(overrides: Partial<ApiConnection> & Pick<ApiConnection, "service">): ApiConnection {
  return {
    id: `conn-${overrides.service}`,
    label: overrides.service,
    grants: {},
    display: {},
    capabilities: {
      talk: { state: "unlocked" },
      act: { state: "unsupported" },
      watch: { state: "unsupported" },
    },
    connect: null,
    ...overrides,
  };
}

function composio(overrides: Partial<ComposioCliStatus> = {}): ComposioCliStatus {
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

describe("buildConnectionCards — active setup discovery", () => {
  it("threads the per-grant active setup id onto its slot", () => {
    const cards = buildConnectionCards([
      conn({
        service: "discord",
        id: "conn-discord",
        grants: { bot: "unauthorized" },
        setups: { bot: "cid-123" },
      }),
    ]);
    const discord = cards.find((c) => c.service === "discord");
    expect(discord?.slots[0].activeSetupCid).toBe("cid-123");
  });

  it("defaults the active setup id to null when none is in progress", () => {
    const cards = buildConnectionCards([
      conn({ service: "discord", id: "conn-discord", grants: { bot: "unauthorized" } }),
    ]);
    const discord = cards.find((c) => c.service === "discord");
    expect(discord?.slots[0].activeSetupCid).toBeNull();
  });
});

describe("buildConnectionCards — runtime degradation", () => {
  it("projects an unlocked capability degradation onto its connection card", () => {
    const cards = buildConnectionCards([
      conn({
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

    expect(cards[0].degradation).toEqual({
      reason: "WeChat reported a stale session.",
      retryAt: "2026-07-20T12:00:00.000Z",
    });
    expect(cards[0].slots[0].state).toBe("authorized");
  });
});

describe("buildConnectionCards — Telegram fold", () => {
  it("folds telegram_user onto the Telegram card as its session slot", () => {
    const cards = buildConnectionCards([
      conn({
        service: "telegram",
        id: "conn-tg",
        grants: { bot: "authorized" },
        display: { bot: display({ handle: "mybot" }) },
      }),
      conn({
        service: "telegram_user",
        id: "conn-tg-user",
        grants: { session: "authorized" },
        display: { session: display({ displayName: "My Name", handle: "me" }) },
      }),
    ]);

    // One card — no separate telegram_user card.
    expect(cards.map((c) => c.service)).toEqual(["telegram"]);
    const telegram = cards[0];
    expect(telegram.label).toBe("Telegram");
    expect(telegram.slots).toHaveLength(2);

    const bot = telegram.slots.find((s) => s.key === "bot");
    expect(bot).toMatchObject({
      connectionId: "conn-tg",
      grant: "bot",
      state: "authorized",
      identity: "mybot",
    });

    // The session slot keeps its OWN connection id + grant (it revokes against
    // the telegram_user row) and carries the account's display identity.
    const session = telegram.slots.find((s) => s.key === "session");
    expect(session).toMatchObject({
      connectionId: "conn-tg-user",
      grant: "session",
      state: "authorized",
      identity: "My Name",
    });
    expect(session?.display).toEqual(display({ displayName: "My Name", handle: "me" }));
  });

  it("a personal account with no telegram connection still yields a Telegram card with just the session slot", () => {
    const cards = buildConnectionCards([
      conn({
        service: "telegram_user",
        id: "conn-tg-user",
        grants: { session: "degraded" },
        display: { session: display({ displayName: "My Name" }) },
      }),
    ]);

    expect(cards).toHaveLength(1);
    const telegram = cards[0];
    expect(telegram.service).toBe("telegram");
    expect(telegram.label).toBe("Telegram");
    expect(telegram.kind).toBe("channel");
    expect(telegram.slots).toHaveLength(1);
    expect(telegram.slots[0]).toMatchObject({
      key: "session",
      connectionId: "conn-tg-user",
      grant: "session",
      state: "degraded",
      identity: "My Name",
    });
  });
});

describe("buildConnectionCards — Composio card", () => {
  it("appends a composio card only when the CLI is installed, and always last", () => {
    const connections = [
      conn({ service: "github", grants: { user: "authorized" } }),
      conn({ service: "telegram", grants: { bot: "authorized" } }),
    ];

    expect(buildConnectionCards(connections).some((c) => c.service === "composio")).toBe(false);
    expect(buildConnectionCards(connections, null).some((c) => c.service === "composio")).toBe(
      false,
    );
    expect(
      buildConnectionCards(connections, composio({ installed: false })).some(
        (c) => c.service === "composio",
      ),
    ).toBe(false);

    const withComposio = buildConnectionCards(connections, composio({ installed: true }));
    const last = withComposio[withComposio.length - 1];
    expect(last.service).toBe("composio");
    expect(last.kind).toBe("composio");
    expect(last.label).toBe("Composio");
    expect(last.alwaysOn).toBe(false);
  });

  it("maps the CLI login state onto the synthetic slot's grant state", () => {
    const loggedOut = buildConnectionCards([], composio({ loggedIn: false }));
    expect(loggedOut[0].slots).toEqual([
      {
        key: "user",
        connectionId: null,
        grant: null,
        state: "unauthorized",
        display: null,
        identity: null,
        activeSetupCid: null,
      },
    ]);

    const loggedIn = buildConnectionCards([], composio({ loggedIn: true }));
    expect(loggedIn[0].slots[0].state).toBe("authorized");
  });
});

describe("buildConnectionCards — ordering", () => {
  it("sorts known services into the fixed order regardless of input order", () => {
    const cards = buildConnectionCards([
      conn({ service: "slack" }),
      conn({ service: "google" }),
      conn({ service: "webchat" }),
      conn({ service: "github" }),
      conn({ service: "email" }),
      conn({ service: "discord" }),
      conn({ service: "feishu" }),
      conn({ service: "wechat" }),
      conn({ service: "whatsapp" }),
      conn({ service: "telegram" }),
    ]);
    expect(cards.map((c) => c.service)).toEqual([
      "telegram",
      "whatsapp",
      "wechat",
      "discord",
      "email",
      "feishu",
      "webchat",
      "github",
      "google",
      "slack",
    ]);
  });

  it("places unknown services after the known ones, alphabetically, with composio last", () => {
    const cards = buildConnectionCards(
      [
        conn({ service: "zulip" }),
        conn({ service: "slack" }),
        conn({ service: "acme" }),
        conn({ service: "telegram" }),
      ],
      composio(),
    );
    expect(cards.map((c) => c.service)).toEqual(["telegram", "slack", "acme", "zulip", "composio"]);
  });
});

describe("buildConnectionCards — slot mapping", () => {
  it("maps each channel's Talk grant onto the bot slot whatever the grant is named", () => {
    const cards = buildConnectionCards([
      conn({ service: "wechat", grants: { account: "authorized" } }),
      conn({ service: "whatsapp", grants: { session: "unauthorized" } }),
      conn({ service: "email", grants: { inbox: "authorized" } }),
    ]);
    for (const card of cards) {
      expect(card.slots).toHaveLength(1);
      expect(card.slots[0].key, `${card.service} grant should render as bot`).toBe("bot");
    }
    // The revoke target stays the registry grant name, not the slot key.
    expect(cards.find((c) => c.service === "wechat")?.slots[0].grant).toBe("account");
  });

  it("maps OAuth conferrals onto the user slot, Slack's workspace grant included", () => {
    const cards = buildConnectionCards([
      conn({ service: "slack", grants: { workspace: "authorized" } }),
      conn({ service: "github", grants: { user: "authorized" } }),
    ]);
    const slack = cards.find((c) => c.service === "slack");
    expect(slack?.slots[0]).toMatchObject({ key: "user", grant: "workspace" });
    expect(cards.find((c) => c.service === "github")?.slots[0].key).toBe("user");
  });

  it("webchat is alwaysOn with one synthesized authorized slot (zero-grant service)", () => {
    const cards = buildConnectionCards([conn({ service: "webchat", id: "conn-webchat" })]);
    expect(cards).toHaveLength(1);
    const webchat = cards[0];
    expect(webchat.alwaysOn).toBe(true);
    expect(webchat.kind).toBe("channel");
    expect(webchat.slots).toEqual([
      {
        key: "bot",
        connectionId: "conn-webchat",
        grant: null,
        state: "authorized",
        display: null,
        identity: null,
        activeSetupCid: null,
      },
    ]);
  });

  it("folds the slot identity as displayName || handle || email", () => {
    const cards = buildConnectionCards([
      conn({
        service: "github",
        grants: { user: "authorized" },
        display: {
          user: display({ displayName: "Ada", handle: "ada", email: "ada@example.com" }),
        },
      }),
      conn({
        service: "google",
        grants: { user: "authorized" },
        display: { user: display({ handle: "ada", email: "ada@example.com" }) },
      }),
      conn({
        service: "slack",
        grants: { workspace: "authorized" },
        display: { workspace: display({ email: "ada@example.com" }) },
      }),
      conn({ service: "telegram", grants: { bot: "unauthorized" }, display: {} }),
    ]);
    const identityOf = (service: string) =>
      cards.find((c) => c.service === service)?.slots[0].identity;
    expect(identityOf("github")).toBe("Ada");
    expect(identityOf("google")).toBe("ada");
    expect(identityOf("slack")).toBe("ada@example.com");
    expect(identityOf("telegram")).toBeNull();
  });

  it("keeps offerable placeholders: null connection id flows through to the slot", () => {
    const cards = buildConnectionCards([
      conn({ service: "github", id: null, grants: { user: "unauthorized" } }),
    ]);
    expect(cards[0].slots[0]).toMatchObject({
      connectionId: null,
      grant: "user",
      state: "unauthorized",
    });
  });
});

describe("buildConnectionCards — kind and labels", () => {
  it("assigns oauth kind to github/google/slack and channel kind to the talk channels", () => {
    const cards = buildConnectionCards([
      conn({ service: "github" }),
      conn({ service: "google" }),
      conn({ service: "slack" }),
      conn({ service: "telegram" }),
      conn({ service: "whatsapp" }),
      conn({ service: "email" }),
    ]);
    const kindOf = (service: string) => cards.find((c) => c.service === service)?.kind;
    expect(kindOf("github")).toBe("oauth");
    expect(kindOf("google")).toBe("oauth");
    expect(kindOf("slack")).toBe("oauth");
    expect(kindOf("telegram")).toBe("channel");
    expect(kindOf("whatsapp")).toBe("channel");
    expect(kindOf("email")).toBe("channel");
  });

  it("uses brand labels for known services and capitalizes unknown ones", () => {
    const cards = buildConnectionCards([
      conn({ service: "github" }),
      conn({ service: "wechat" }),
      conn({ service: "zulip" }),
    ]);
    const labelOf = (service: string) => cards.find((c) => c.service === service)?.label;
    expect(labelOf("github")).toBe("GitHub");
    expect(labelOf("wechat")).toBe("WeChat");
    expect(labelOf("zulip")).toBe("Zulip");
  });

  it("carries the connect hint through to the card", () => {
    const hint = { url: "https://oauth/github", available: true, unavailableReason: null };
    const cards = buildConnectionCards([conn({ service: "github", connect: hint })]);
    expect(cards[0].connect).toEqual(hint);
  });
});
