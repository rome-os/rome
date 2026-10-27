import { describe, expect, it } from "@rstest/core";
import { buildConnectionCards } from "@/lib/connection-cards";
import type { ConnectionCard, ConnectionSlot } from "@/lib/connection-cards";
import { connectionStatus } from "@/lib/connection-status";
import type { ApiConnection, ConnectionState, GrantState } from "@/lib/connections-api";
import { stateOfGrants } from "@/test/connection-state";

/**
 * The status vocabulary the guardian actually reads on a row. These assertions
 * pin the slot-state → { label, tone } mapping directly — the row and the
 * detail header both go through `connectionStatus`, so this is the single
 * behavioral contract for what "Working" / "Broken" / "Not connected" / "Unavailable"
 * mean and which dot tone each carries.
 */

function slot(
  state: ConnectionState | null,
  overrides: Partial<ConnectionSlot> = {},
): ConnectionSlot {
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
    degradation: null,
    slots: [],
    connect: null,
    ...overrides,
  };
}

describe("connectionStatus — status vocabulary", () => {
  it("a working slot ⇒ green Working", () => {
    expect(connectionStatus(card({ slots: [slot("working")] }))).toEqual({
      label: "Working",
      tone: "success",
    });
  });

  it("a transient runtime impairment ⇒ amber Working, with the reason", () => {
    expect(
      connectionStatus(
        card({
          degradation: {
            reason: "WeChat reported a stale session.",
            retryAt: "2026-07-20T12:00:00.000Z",
          },
          slots: [slot("working")],
        }),
      ),
    ).toEqual({
      label: "Working",
      tone: "attention",
      title: "WeChat reported a stale session. Automatic retry at 2026-07-20T12:00:00.000Z.",
    });
  });

  it("a broken slot beats a working sibling ⇒ attention-toned Broken", () => {
    expect(
      connectionStatus(card({ slots: [slot("working"), slot("broken", { key: "session" })] })),
    ).toEqual({
      label: "Broken",
      tone: "attention",
      title: "The platform stopped accepting Rome's access. Give access again.",
    });
  });

  it("a lone broken slot ⇒ attention-toned Broken", () => {
    expect(connectionStatus(card({ slots: [slot("broken")] }))).toEqual({
      label: "Broken",
      tone: "attention",
      title: "The platform stopped accepting Rome's access. Give access again.",
    });
  });

  it("no state ⇒ muted Not connected", () => {
    expect(connectionStatus(card({ slots: [slot(null)] }))).toEqual({
      label: "Not connected",
      tone: "muted",
    });
  });

  it("no state with a ledger row (a kept disconnect) is still a muted Not connected, not attention", () => {
    expect(connectionStatus(card({ slots: [slot(null, { connectionId: "conn-1" })] }))).toEqual({
      label: "Not connected",
      tone: "muted",
    });
  });

  it("nothing granted + unavailable connect hint ⇒ muted Unavailable, carrying the reason as a title", () => {
    expect(
      connectionStatus(
        card({
          service: "github",
          kind: "oauth",
          slots: [slot(null, { key: "user", connectionId: null, grant: "user" })],
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

  it("a working slot wins over an unavailable connect hint", () => {
    expect(
      connectionStatus(
        card({
          slots: [slot("working")],
          connect: { url: null, available: false, unavailableReason: "down" },
        }),
      ),
    ).toEqual({ label: "Working", tone: "success" });
  });

  it("nothing granted + available connect hint ⇒ muted Not connected", () => {
    expect(
      connectionStatus(
        card({
          slots: [slot(null)],
          connect: { url: "https://oauth/x", available: true, unavailableReason: null },
        }),
      ),
    ).toEqual({ label: "Not connected", tone: "muted" });
  });
});

/**
 * The Telegram fold's row status, driven end-to-end from the registry
 * connections through `buildConnectionCards` → `connectionStatus`. The
 * any-working rule means a working bot with no personal account is fully
 * "Working" (no "1 of 2" nagging), and a broken slot overrides that.
 */
describe("connectionStatus — Telegram fold row states", () => {
  function telegramConn(state: GrantState): ApiConnection {
    return {
      id: "conn-tg",
      connectionKind: "telegram",
      label: "Telegram",
      state: stateOfGrants({ bot: state }),
      grants: { bot: state },
      display: {
        bot: { displayName: null, handle: "mybot", email: null, avatarUrl: null },
      },
      capabilities: {
        chat: { state: "unlocked" },
        act: { state: "unsupported" },
        watch: { state: "unsupported" },
      },
      connect: null,
      setups: {},
      channel: null,
      agent: null,
      severalAccounts: false,
    };
  }

  function telegramUserConn(state: GrantState): ApiConnection {
    return {
      id: "conn-tg-user",
      connectionKind: "telegram_user",
      label: "Telegram personal account",
      state: stateOfGrants({ session: state }),
      grants: { session: state },
      display: {
        session: { displayName: "My Name", handle: "me", email: null, avatarUrl: null },
      },
      capabilities: {
        chat: { state: "unlocked" },
        act: { state: "unsupported" },
        watch: { state: "unsupported" },
      },
      connect: null,
      setups: {},
      channel: null,
      agent: null,
      severalAccounts: false,
    };
  }

  function telegramStatus(connections: ApiConnection[]) {
    const telegram = buildConnectionCards(connections).find((c) => c.service === "telegram");
    if (!telegram) throw new Error("no telegram card");
    return connectionStatus(telegram);
  }

  it("neither granted ⇒ Not connected", () => {
    expect(telegramStatus([telegramConn("unauthorized")])).toEqual({
      label: "Not connected",
      tone: "muted",
    });
  });

  it("bot-only: bot working, no personal account ⇒ Working (no 1-of-2 nagging)", () => {
    expect(telegramStatus([telegramConn("authorized")])).toEqual({
      label: "Working",
      tone: "success",
    });
  });

  it("account-only: personal account working, no bot connection ⇒ Working", () => {
    expect(telegramStatus([telegramUserConn("authorized")])).toEqual({
      label: "Working",
      tone: "success",
    });
  });

  it("both working ⇒ Working", () => {
    expect(telegramStatus([telegramConn("authorized"), telegramUserConn("authorized")])).toEqual({
      label: "Working",
      tone: "success",
    });
  });

  it("bot working + personal account broken ⇒ attention override (Broken)", () => {
    expect(telegramStatus([telegramConn("authorized"), telegramUserConn("degraded")])).toEqual({
      label: "Broken",
      tone: "attention",
      title: "The platform stopped accepting Rome's access. Give access again.",
    });
  });
});
