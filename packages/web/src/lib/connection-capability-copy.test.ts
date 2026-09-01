import { describe, expect, it } from "@rstest/core";
import enSettings from "@/i18n/locales/en/settings.json";
import zhSettings from "@/i18n/locales/zh-CN/settings.json";
import type { ConnectionSlot, SlotKey } from "@/lib/connection-cards";
import { slotCardCopy, slotHeadingKey } from "./connection-capability-copy";

function slot(key: SlotKey, overrides: Partial<ConnectionSlot> = {}): ConnectionSlot {
  return {
    key,
    connectionId: null,
    grant: null,
    state: "unauthorized",
    display: null,
    identity: null,
    ...overrides,
  };
}

/** Resolve a dotted i18n key against a bundle, so the test asserts the key the
 * seam emits actually exists in the settings namespace. */
function lookup(bundle: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((acc, part) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[part];
    return undefined;
  }, bundle);
}

describe("slotHeadingKey", () => {
  it("maps the three card roles to their heading keys", () => {
    expect(slotHeadingKey("connected")).toBe("connections.headings.connected");
    expect(slotHeadingKey("primary")).toBe("connections.headings.primary");
    expect(slotHeadingKey("secondary")).toBe("connections.headings.secondary");
  });

  it("emits heading keys that exist in both bundles", () => {
    for (const role of ["connected", "primary", "secondary"] as const) {
      const key = slotHeadingKey(role);
      expect(lookup(enSettings, key), `missing en copy for ${key}`).toBeTypeOf("string");
      expect(lookup(zhSettings, key), `missing zh copy for ${key}`).toBeTypeOf("string");
    }
    expect(lookup(enSettings, "connections.headings.availableToAdd")).toBeTypeOf("string");
    expect(lookup(zhSettings, "connections.headings.availableToAdd")).toBeTypeOf("string");
  });
});

describe("slotCardCopy", () => {
  it("gives the Telegram bot slot fallback title + fallback bullets before the identity is known", () => {
    const copy = slotCardCopy("telegram", slot("bot"), false);
    expect(copy.title).toEqual({ key: "connections.cards.telegram.bot.titleFallback" });
    expect(copy.subtitle).toEqual({ key: "connections.cards.telegram.bot.subtitle" });
    expect(copy.bullets.map((b) => b.key)).toEqual([
      "connections.cards.telegram.bot.bulletsFallback.reply",
      "connections.cards.telegram.bot.bulletsFallback.start",
    ]);
    expect(copy.privacyNote).toBeNull();
  });

  it("yields the Telegram bot title to the identity and interpolates it into the bullets once known", () => {
    const copy = slotCardCopy(
      "telegram",
      slot("bot", { state: "authorized", identity: "@fujian_helper_bot" }),
      true,
    );
    // Title is null: the connected @identity is the card title, supplied by the caller.
    expect(copy.title).toBeNull();
    expect(copy.bullets[0]).toEqual({
      key: "connections.cards.telegram.bot.bullets.reply",
      params: { identity: "@fujian_helper_bot" },
    });
  });

  it("gives the Telegram session slot its static title, three bullets, and privacy note", () => {
    const copy = slotCardCopy("telegram", slot("session"), false);
    expect(copy.title).toEqual({ key: "connections.cards.telegram.session.title" });
    expect(copy.bullets.map((b) => b.key)).toEqual([
      "connections.cards.telegram.session.bullets.send",
      "connections.cards.telegram.session.bullets.read",
      "connections.cards.telegram.session.bullets.notice",
    ]);
    expect(copy.privacyNote).toEqual({ key: "connections.cards.telegram.session.privacyNote" });
  });

  it("gives GitHub's user slot the work + watch bullets and an OAuth privacy note", () => {
    const copy = slotCardCopy("github", slot("user"), false);
    expect(copy.title).toEqual({ key: "connections.cards.github.user.title" });
    expect(copy.bullets.map((b) => b.key)).toEqual([
      "connections.cards.github.user.bullets.work",
      "connections.cards.github.user.bullets.watch",
    ]);
    expect(copy.privacyNote).toEqual({ key: "connections.cards.github.user.privacyNote" });
  });

  it("gives the composio slot one generic bullet and no privacy note", () => {
    const copy = slotCardCopy("composio", slot("user"), false);
    expect(copy.bullets.map((b) => b.key)).toEqual(["connections.cards.composio.user.bullets.act"]);
    expect(copy.privacyNote).toBeNull();
  });

  it("emits every card key it resolves in both the en and zh bundles", () => {
    const cases: Array<[string, ConnectionSlot, boolean]> = [
      ["telegram", slot("bot", { identity: "@bot" }), true],
      ["telegram", slot("bot"), false],
      ["telegram", slot("session"), false],
      ["whatsapp", slot("bot"), false],
      ["wechat", slot("bot"), false],
      ["discord", slot("bot", { identity: "@dbot" }), true],
      ["discord", slot("bot"), false],
      ["feishu", slot("bot"), false],
      ["email", slot("bot"), false],
      ["webchat", slot("bot"), false],
      ["github", slot("user"), false],
      ["google", slot("user"), false],
      ["slack", slot("user"), false],
      ["composio", slot("user"), false],
    ];
    for (const [service, s, known] of cases) {
      const copy = slotCardCopy(service, s, known);
      const keys = [
        copy.title?.key,
        copy.subtitle?.key,
        copy.privacyNote?.key,
        ...copy.bullets.map((b) => b.key),
      ].filter((k): k is string => Boolean(k));
      // Every slot resolves at least one bullet.
      expect(copy.bullets.length, `${service}/${s.key} should have bullets`).toBeGreaterThan(0);
      for (const key of keys) {
        expect(lookup(enSettings, key), `missing en copy for ${key}`).toBeTypeOf("string");
        expect(lookup(zhSettings, key), `missing zh copy for ${key}`).toBeTypeOf("string");
      }
    }
  });
});
