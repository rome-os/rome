import { describe, expect, it } from "@rstest/core";
import { buildConnectionCards } from "@/lib/connection-cards";
import type { ConnectionCard, ConnectionSlot } from "@/lib/connection-cards";
import { connectionStatus } from "@/lib/connection-status";
import type { ApiConnection, GrantState } from "@/lib/connections-api";

/**
 * The status vocabulary the guardian actually reads on a row. These assertions
 * pin the slot-state → { label, tone } mapping directly — the row and the
 * detail header both go through `connectionStatus`, so this is the single
 * behavioral contract for what "Connected" / "Not connected" / "Unavailable"
 * mean and which dot tone each carries.
 */

function slot(state: GrantState, overrides: Partial<ConnectionSlot> = {}): ConnectionSlot {
  return {
    key: "bot",
    connectionId: "conn-1",
    grant: "bot",
    state,
    display: null,
    identity: null,
    ...overrides,
  };
}

function card(overrides: Partial<ConnectionCard> = {}): ConnectionCard {
  return {
    service: "telegram",
    label: "Telegram",
    kind: "channel",
    alwaysOn: false,
    degradation: null,
    slots: [],
    connect: null,
    ...overrides,
  };
}

describe("connectionStatus — status vocabulary", () => {
  it("alwaysOn (webchat) ⇒ green Connected, regardless of slots", () => {
    expect(connectionStatus(card({ service: "webchat", alwaysOn: true, slots: [] }))).toEqual({
      label: "Connected",
      tone: "success",
    });
  });

  it("an authorized slot ⇒ green Connected", () => {
    expect(connectionStatus(card({ slots: [slot("authorized")] }))).toEqual({
      label: "Connected",
      tone: "success",
    });
  });

  it("a transient runtime impairment ⇒ amber Degraded without changing the grant slot", () => {
    expect(
      connectionStatus(
        card({
          degradation: {
            reason: "WeChat reported a stale session.",
            retryAt: "2026-07-20T12:00:00.000Z",
          },
          slots: [slot("authorized")],
        }),
      ),
    ).toEqual({
      label: "Degraded",
      tone: "attention",
      title: "WeChat reported a stale session. Automatic retry at 2026-07-20T12:00:00.000Z.",
    });
  });

  it("a degraded slot beats an authorized sibling ⇒ attention-toned Not connected", () => {
    expect(
      connectionStatus(card({ slots: [slot("authorized"), slot("degraded", { key: "session" })] })),
    ).toEqual({
      label: "Not connected",
      tone: "attention",
      title: "Access expired — reconnect",
    });
  });

  it("a lone degraded slot ⇒ attention-toned Not connected", () => {
    expect(connectionStatus(card({ slots: [slot("degraded")] }))).toEqual({
      label: "Not connected",
      tone: "attention",
      title: "Access expired — reconnect",
    });
  });

  it("unauthorized ⇒ muted Not connected", () => {
    expect(connectionStatus(card({ slots: [slot("unauthorized")] }))).toEqual({
      label: "Not connected",
      tone: "muted",
    });
  });

  it("unauthorized with a ledger row (mid-ceremony) is still a muted Not connected, not attention", () => {
    expect(
      connectionStatus(card({ slots: [slot("unauthorized", { connectionId: "conn-1" })] })),
    ).toEqual({ label: "Not connected", tone: "muted" });
  });

  it("nothing conferred + unavailable connect hint ⇒ muted Unavailable, carrying the reason as a title", () => {
    expect(
      connectionStatus(
        card({
          service: "github",
          kind: "oauth",
          slots: [slot("unauthorized", { key: "user", connectionId: null, grant: "user" })],
          connect: {
            url: null,
            available: false,
            unavailableReason: "Not configured on this host",
          },
        }),
      ),
    ).toEqual({
      label: "Unavailable",
      tone: "muted",
      title: "Not configured on this host",
    });
  });

  it("an authorized slot wins over an unavailable connect hint", () => {
    expect(
      connectionStatus(
        card({
          slots: [slot("authorized")],
          connect: { url: null, available: false, unavailableReason: "down" },
        }),
      ),
    ).toEqual({ label: "Connected", tone: "success" });
  });

  it("nothing conferred + available connect hint ⇒ muted Not connected", () => {
    expect(
      connectionStatus(
        card({
          slots: [slot("unauthorized")],
          connect: { url: "https://oauth/x", available: true, unavailableReason: null },
        }),
      ),
    ).toEqual({ label: "Not connected", tone: "muted" });
  });
});

/**
 * The Telegram fold's row status, driven end-to-end from the registry
 * connections through `buildConnectionCards` → `connectionStatus`. The
 * any-authorized rule means a working bot with no personal account is fully
 * "Connected" (no "1 of 2" nagging); a degraded slot overrides that.
 */
describe("connectionStatus — Telegram fold row states", () => {
  function telegramConn(state: GrantState): ApiConnection {
    return {
      id: "conn-tg",
      service: "telegram",
      label: "Telegram",
      grants: { bot: state },
      display: {
        bot: { displayName: null, handle: "mybot", email: null, avatarUrl: null },
      },
      capabilities: {
        talk: { state: "unlocked" },
        act: { state: "unsupported" },
        watch: { state: "unsupported" },
      },
      connect: null,
    };
  }

  function telegramUserConn(state: GrantState): ApiConnection {
    return {
      id: "conn-tg-user",
      service: "telegram_user",
      label: "Telegram personal account",
      grants: { session: state },
      display: {
        session: { displayName: "My Name", handle: "me", email: null, avatarUrl: null },
      },
      capabilities: {
        talk: { state: "unlocked" },
        act: { state: "unsupported" },
        watch: { state: "unsupported" },
      },
      connect: null,
    };
  }

  function telegramStatus(connections: ApiConnection[]) {
    const telegram = buildConnectionCards(connections).find((c) => c.service === "telegram");
    if (!telegram) throw new Error("no telegram card");
    return connectionStatus(telegram);
  }

  it("neither conferred ⇒ Not connected", () => {
    expect(telegramStatus([telegramConn("unauthorized")])).toEqual({
      label: "Not connected",
      tone: "muted",
    });
  });

  it("bot-only: bot authorized, no personal account ⇒ Connected (no 1-of-2 nagging)", () => {
    expect(telegramStatus([telegramConn("authorized")])).toEqual({
      label: "Connected",
      tone: "success",
    });
  });

  it("account-only: personal account authorized, no bot connection ⇒ Connected", () => {
    expect(telegramStatus([telegramUserConn("authorized")])).toEqual({
      label: "Connected",
      tone: "success",
    });
  });

  it("both authorized ⇒ Connected", () => {
    expect(telegramStatus([telegramConn("authorized"), telegramUserConn("authorized")])).toEqual({
      label: "Connected",
      tone: "success",
    });
  });

  it("bot authorized + personal-account session degraded ⇒ attention override (Not connected, attention)", () => {
    expect(telegramStatus([telegramConn("authorized"), telegramUserConn("degraded")])).toEqual({
      label: "Not connected",
      tone: "attention",
      title: "Access expired — reconnect",
    });
  });
});
