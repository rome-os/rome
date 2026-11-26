import { afterEach, describe, expect, it, rs } from "@rstest/core";
import {
  ACCOUNT_KINDS,
  GUARDIAN_OWN_KINDS,
} from "../../../../../rome_apps/dream/src/lib/chat-activity.js";
import { setInstanceTokenInMemory } from "../../instance/instance-identity.js";
import { BUILTIN_ACCOUNT_LINKS } from "../../test/db.js";
import { feishu, type FeishuDescriptorDeps } from "../kinds/feishu/index.js";
import { linkedin, type LinkedInDescriptorDeps } from "../kinds/linkedin/index.js";
import { discordApp, type DiscordAppDescriptorDeps } from "../kinds/discord-app/index.js";
import { ConnectionRegistry } from "../registry.js";
import type { ConnectionsRepository, StoredConnection } from "../repository.js";
import type { Logger } from "../../logger.js";
import type { ConnectionDescriptor, RuntimeKit } from "../types.js";
import { type BuiltinConnectionDeps, registerBuiltinConnections } from "./index.js";
import type {
  ChatSettingField,
  ChatSettingsOverrides,
  ChatSettingsSnapshot,
} from "@rome-os/app-runtime";
import {
  asChatSettings,
  CHAT_RULE_NAMES,
  type ChatRuleName,
  type ChatRules,
  chatRuleDefaults,
  chatRulesOf,
  effectiveChatRules,
} from "../../chat-settings/rules.js";
import {
  chatRules,
  chatSettingsWake,
  type WakeMessage,
} from "../../participation/wake-gate/index.js";

/**
 * Registers what boot registers: the built-in kinds, then each kind the wiring
 * mounts on its own. A kind that moves to connections/kinds/ joins the list
 * here too, so the checks over every kind keep covering it.
 */
function registerEveryKind(registry: ConnectionRegistry): void {
  registerBuiltinConnections(registry, {
    listAgents: () => [],
    slackApp: {
      api: {},
      cloud: {},
      openMailbox: () => ({ stop() {}, attempts: 4 }),
    },
  } as unknown as BuiltinConnectionDeps);
  const mounted = [
    feishu({ listAgents: () => [] } as unknown as FeishuDescriptorDeps),
    linkedin({} as unknown as LinkedInDescriptorDeps),
    discordApp({} as unknown as DiscordAppDescriptorDeps),
  ];
  for (const kind of mounted) {
    if (kind.descriptor) registry.register(kind.descriptor);
  }
}

describe("registerBuiltinConnections", () => {
  afterEach(() => {
    rs.unstubAllGlobals();
    rs.unstubAllEnvs();
    setInstanceTokenInMemory(null);
  });
  it("renews through Rome Cloud only for providers Rome Cloud can refresh", async () => {
    rs.stubEnv("PANTHEON_BASE_ORIGIN", "https://cloud.example.test");
    setInstanceTokenInMemory("romeinst_test-instance-token");
    const fetchMock = rs.fn(async (_url: unknown, init?: RequestInit) => {
      const provider = JSON.parse(init!.body as string).provider;
      return Response.json({
        provider,
        tokens: {
          accessToken: "test-new",
          refreshToken: "test-refresh",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        },
      });
    });
    rs.stubGlobal("fetch", fetchMock);
    const registered = new Map<string, ConnectionDescriptor>();
    const registry = {
      register: (descriptor: ConnectionDescriptor) =>
        registered.set(descriptor.connectionKind, descriptor),
    } as unknown as ConnectionRegistry;
    registerBuiltinConnections(registry, {
      listAgents: () => [],
    } as unknown as BuiltinConnectionDeps);

    const expired = {
      material: { accessToken: "ya29.old", refreshToken: "1//refresh" },
      expiresAt: new Date(0),
    };
    await expect(registered.get("github")!.auth.renew(expired)).resolves.toBe("needs-fix");
    expect(fetchMock).not.toHaveBeenCalled();
    for (const provider of ["google", "shopify"]) {
      await expect(registered.get(provider)!.auth.renew(expired)).resolves.toMatchObject({
        material: { accessToken: "test-new", refreshToken: "test-refresh" },
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // Stored Slack bot (`slack_bot`) connections stay in the store after the
  // kind is removed.
  it("boots past a stored Slack bot, skipping it, and still offers Rome's Slack app", async () => {
    const stored = {
      id: "conn-slack-bot",
      connectionKind: "slack_bot",
      label: "Slack bot",
      createdAt: new Date("2026-10-01T00:00:00Z"),
      grant: { state: "unauthorized" },
    } as unknown as StoredConnection;
    const warn = rs.fn();
    const logger = { warn, info() {}, error() {}, debug() {} } as unknown as Logger;
    const registry = new ConnectionRegistry({
      repository: { all: async () => [stored] } as unknown as ConnectionsRepository,
      logger,
    });
    registerEveryKind(registry);

    await registry.load();

    expect(warn).toHaveBeenCalledWith("Skipping connection for unregistered connectionKind", {
      connectionId: "conn-slack-bot",
      connectionKind: "slack_bot",
    });
    expect(registry.all()).toEqual([]);
    expect(registry.registeredKinds()).toContain("slack_app");
    expect(registry.registeredKinds()).not.toContain("slack_bot");
  });

  // A bot takes an agent as its own account and the guardian's signed-in
  // account as a delegate; Dream and the test fixtures keep their own lists of
  // these kinds, so all three must agree.
  it("declares the kind of link for exactly the kinds that take an agent", () => {
    const registered = new Map<string, ConnectionDescriptor>();
    const registry = {
      register: (descriptor: ConnectionDescriptor) =>
        registered.set(descriptor.connectionKind, descriptor),
    } as unknown as ConnectionRegistry;

    registerEveryKind(registry);

    const links = Object.fromEntries(
      [...registered.values()]
        .filter((descriptor) => descriptor.link !== undefined)
        .map((descriptor) => [descriptor.connectionKind, descriptor.link]),
    );
    expect(links).toEqual({
      feishu: "own_account",
      telegram: "own_account",
      discord: "own_account",
      slack_app: "own_account",
      discord_app: "own_account",
      telegram_user: "delegate",
    });
    // Only a kind with a Talk can be a connected account.
    for (const kind of Object.keys(links)) {
      expect(registered.get(kind)?.capabilities.talker).toBeDefined();
    }
    expect(links).toEqual(BUILTIN_ACCOUNT_LINKS);
    expect(
      Object.keys(links)
        .filter((kind) => links[kind] === "own_account")
        .sort(),
    ).toEqual([...ACCOUNT_KINDS].sort());
    expect(
      Object.keys(links)
        .filter((kind) => links[kind] === "delegate")
        .sort(),
    ).toEqual([...GUARDIAN_OWN_KINDS].sort());
  });

  it("starts a new account with the Concierge only for Rome's Slack and Discord apps", () => {
    const registered: ConnectionDescriptor[] = [];
    registerEveryKind({
      register: (descriptor: ConnectionDescriptor) => registered.push(descriptor),
    } as unknown as ConnectionRegistry);

    expect(
      registered
        .filter((descriptor) => descriptor.startsWithConcierge === true)
        .map((descriptor) => descriptor.connectionKind),
    ).toEqual(["slack_app", "discord_app"]);
  });

  // A grant names the account it reaches, and every kind with a platform has
  // accounts (docs/domains/connections.md#grant).
  it("names the account for every kind", () => {
    const registered = new Map<string, ConnectionDescriptor>();
    const registry = {
      register: (descriptor: ConnectionDescriptor) =>
        registered.set(descriptor.connectionKind, descriptor),
    } as unknown as ConnectionRegistry;

    registerEveryKind(registry);

    const unnamed = [...registered.values()]
      .filter((descriptor) => !descriptor.accountIdOf)
      .map((descriptor) => descriptor.connectionKind);
    expect(unnamed).toEqual([]);
  });
});

// ── Chat rules ──────────────────────────────────────────────────────────────
// Core owns the rules; each kind only declares which it offers and fixes the
// values of the rest (docs/domains/chats.md#chat-rule).

/** Every registered kind, by its id. */
function everyKind(): Map<string, ConnectionDescriptor> {
  const registered = new Map<string, ConnectionDescriptor>();
  registerEveryKind({
    register: (descriptor: ConnectionDescriptor) =>
      registered.set(descriptor.connectionKind, descriptor),
  } as unknown as ConnectionRegistry);
  return registered;
}

/** The rules each kind offered, and how the wake gate read the others, before
 *  kinds declared their rules: the table in chat-settings/support.ts and
 *  `chatRules` in participation/wake-gate/load.ts as they stood. */
const BEFORE_OFFERED = new Map<string, readonly ChatSettingField[]>([
  [
    "discord",
    [
      "enabled",
      "activation.mode",
      "activation.botMessages",
      "activation.whenOthersMentioned",
      "replies.placement",
      "routing.agentName",
      "session.reset",
    ],
  ],
  [
    "feishu",
    ["enabled", "activation.mode", "replies.placement", "routing.agentName", "session.reset"],
  ],
]);
const BEFORE_CORE: readonly ChatSettingField[] = ["session.reset"];
/** Kinds added after kinds declared their rules, which have no before. */
const DECLARED_FROM_THE_START = new Set(["slack_app", "discord_app"]);

function beforeOffered(kind: string, place: "direct" | "group"): readonly ChatSettingField[] {
  return place === "direct" ? BEFORE_CORE : (BEFORE_OFFERED.get(kind) ?? BEFORE_CORE);
}

/** The effective settings and wake rules as the old path worked them out: the
 *  stored values over the defaults, then the gate skipping a rule not offered. */
function before(kind: string, place: "direct" | "group", stored: ChatSettingsOverrides) {
  const offered = beforeOffered(kind, place);
  const effective = asChatSettings(effectiveChatRules({ offers: CHAT_RULE_NAMES }, stored));
  const has = (field: ChatSettingField) => offered.includes(field);
  return {
    offered,
    effective,
    wake: {
      enabled: effective.enabled,
      replyRule: has("activation.mode") ? effective.activation.mode : "all",
      botMessages: has("activation.botMessages") ? effective.activation.botMessages : "all",
      whenOthersMentioned: has("activation.whenOthersMentioned")
        ? effective.activation.whenOthersMentioned
        : "respond",
    },
  };
}

/** Every value each rule can be stored as. */
const VALUES: { [R in ChatRuleName]: readonly ChatRules[R][] } = {
  enabled: [true, false],
  "activation.mode": ["mention", "all"],
  "activation.botMessages": ["ignore", "mentions", "all"],
  "activation.whenOthersMentioned": ["ignore", "respond"],
  "replies.placement": ["thread", "inline"],
  "routing.agentName": [null, "helper"],
  "session.reset": [{ mode: "none" }, { mode: "idle", idleMinutes: 30 }],
};

/** `values` as the overrides a guardian's choices store. */
function storedOf(values: Partial<ChatRules>): ChatSettingsOverrides {
  const stored: ChatSettingsOverrides = {};
  for (const [rule, value] of Object.entries(values) as [ChatRuleName, unknown][]) {
    if (rule === "enabled") {
      stored.enabled = value as boolean;
      continue;
    }
    const [group, field] = rule.split(".") as [
      "activation" | "replies" | "routing" | "session",
      string,
    ];
    ((stored as Record<string, Record<string, unknown>>)[group] ??= {})[field] = value;
  }
  return stored;
}

/** Each combination of stored values over `rules`, one rule unset or set to each of its values. */
function storedCombinations(rules: readonly ChatRuleName[]): ChatSettingsOverrides[] {
  let combos: Partial<ChatRules>[] = [{}];
  for (const rule of rules) {
    const next: Partial<ChatRules>[] = [];
    for (const combo of combos) {
      next.push(combo);
      for (const value of VALUES[rule]) next.push({ ...combo, [rule]: value });
    }
    combos = next;
  }
  return combos.map(storedOf);
}

const HEARS_MESSAGES = (descriptor: ConnectionDescriptor) =>
  descriptor.capabilities.talker !== undefined;

describe("chat rules", () => {
  it("each kind that hears messages declares its chat rules", () => {
    const undeclared = [...everyKind().values()]
      .filter((descriptor) => HEARS_MESSAGES(descriptor) && !descriptor.chatRules)
      .map((descriptor) => descriptor.connectionKind);
    expect(undeclared).toEqual([]);
  });

  it("offers no chat rules for the official Slack and Discord apps, so their chats run at the defaults", () => {
    for (const kind of ["slack_app", "discord_app"]) {
      const rules = everyKind().get(kind)?.chatRules;
      expect(rules).toEqual({ offers: [] });
      for (const place of ["direct", "group"] as const) {
        expect(chatRulesOf(rules!, place).offers).toEqual([]);
      }
    }
  });

  it("no kind both offers and fixes a rule, or names one twice", () => {
    for (const descriptor of everyKind().values()) {
      const rules = descriptor.chatRules;
      if (!rules) continue;
      const fixed = Object.keys(rules.fixed ?? {});
      expect({
        kind: descriptor.connectionKind,
        both: rules.offers.filter((r) => fixed.includes(r)),
      }).toEqual({ kind: descriptor.connectionKind, both: [] });
      expect(new Set(rules.offers).size).toBe(rules.offers.length);
    }
  });

  // The kinds that existed before declarations offer what they did, and
  // every chat runs on the same values, for every value a guardian could
  // store through the dashboard or an in-chat command.
  it.each(["direct", "group"] as const)("keeps every kind's %s chats as they were", (place) => {
    for (const descriptor of everyKind().values()) {
      if (!HEARS_MESSAGES(descriptor) || !descriptor.chatRules) continue;
      const kind = descriptor.connectionKind;
      if (DECLARED_FROM_THE_START.has(kind)) continue;
      const rules = chatRulesOf(descriptor.chatRules, place);
      expect({ kind, offers: [...rules.offers].sort() }).toEqual({
        kind,
        offers: [...beforeOffered(kind, place)].sort(),
      });
      for (const stored of storedCombinations(rules.offers)) {
        const old = before(kind, place, stored);
        const effective = asChatSettings(effectiveChatRules(rules, stored));
        const snapshot = { effective } as ChatSettingsSnapshot;
        expect({ kind, stored, wake: chatRules(snapshot) }).toEqual({
          kind,
          stored,
          wake: old.wake,
        });
        // The rules outside the wake gate run on what was stored, where offered.
        for (const rule of rules.offers) {
          expect({ kind, rule, value: effectiveChatRules(rules, stored)[rule] }).toEqual({
            kind,
            rule,
            value: effectiveChatRules({ offers: CHAT_RULE_NAMES }, stored)[rule],
          });
        }
        expect(effective.replies).toEqual(old.effective.replies);
      }
    }
  });
});

/** A rule's conformance case: the value stored for it, the message, and what
 *  the wake gate decides for the guardian, whatever else the kind sets. */
interface RuleCase<R extends ChatRuleName> {
  value: ChatRules[R];
  message?: Pick<WakeMessage, "addressing" | "fromBot" | "mentionsOthers">;
  wake?: "wake" | "quiet";
}

const RULE_CASES: { [R in ChatRuleName]: readonly RuleCase<R>[] } = {
  enabled: [
    { value: false, message: { addressing: "mention" }, wake: "quiet" },
    { value: true, message: { addressing: "mention" }, wake: "wake" },
  ],
  "activation.mode": [
    { value: "mention", message: { addressing: "ambient" }, wake: "quiet" },
    { value: "mention", message: { addressing: "mention" }, wake: "wake" },
    { value: "all", message: { addressing: "ambient" }, wake: "wake" },
  ],
  "activation.botMessages": [
    { value: "ignore", message: { addressing: "mention", fromBot: true }, wake: "quiet" },
    { value: "mentions", message: { addressing: "mention", fromBot: true }, wake: "wake" },
    { value: "mentions", message: { addressing: "ambient", fromBot: true }, wake: "quiet" },
    { value: "all", message: { addressing: "mention", fromBot: true }, wake: "wake" },
  ],
  "activation.whenOthersMentioned": [
    { value: "ignore", message: { addressing: "ambient", mentionsOthers: true }, wake: "quiet" },
    { value: "respond", message: { mentionsOthers: true }, wake: "wake" },
  ],
  "replies.placement": [{ value: "inline" }, { value: "thread" }],
  "routing.agentName": [{ value: "helper" }, { value: null }],
  "session.reset": [{ value: { mode: "none" } }, { value: { mode: "daily", atHour: 4 } }],
};

describe("chat rule conformance", () => {
  // A kind that offers a rule runs it as Core does for every other kind.
  for (const descriptor of everyKind().values()) {
    const offers = descriptor.chatRules?.offers ?? [];
    for (const rule of offers) {
      it(`${descriptor.connectionKind} runs ${rule} as stored`, () => {
        const rules = chatRulesOf(descriptor.chatRules ?? { offers: [] }, "group");
        for (const c of RULE_CASES[rule] as readonly RuleCase<typeof rule>[]) {
          const stored = storedOf({ [rule]: c.value });
          const effective = effectiveChatRules(rules, stored);
          expect(effective[rule]).toEqual(c.value);
          if (!c.message) continue;
          const gate = chatSettingsWake({
            ...chatRules({ effective: asChatSettings(effective) } as ChatSettingsSnapshot),
            policies: [],
            connectionKindOf: () => descriptor.connectionKind,
          });
          const decision = gate(
            {
              connectionId: "c1",
              chatId: "chat-1",
              channel: descriptor.connectionKind,
              place: "group",
              ...c.message,
            },
            { person: { id: "guardian" } },
          );
          expect({ rule, value: c.value, message: c.message, decision }).toEqual({
            rule,
            value: c.value,
            message: c.message,
            decision: c.wake,
          });
        }
      });
    }
  }
});

describe("chat rule resolution", () => {
  // Older data can hold a value for a rule a kind does not offer, such as a
  // Telegram group's session agent. The chat runs on the default or the
  // kind's fixed value, never on it.
  it("ignores a value stored for a rule the kind does not offer", () => {
    const stored = storedOf({
      enabled: false,
      "activation.mode": "mention",
      "routing.agentName": "helper",
    });
    const telegram = effectiveChatRules(
      { offers: ["session.reset"], fixed: { "activation.mode": "all" } },
      stored,
    );
    expect(telegram).toMatchObject({
      enabled: true,
      "activation.mode": "all",
      "routing.agentName": null,
    });
  });

  it("runs every rule at its default for a kind that offers none, as an official app", () => {
    const stored = storedOf({ enabled: false, "routing.agentName": "helper" });
    expect(effectiveChatRules({ offers: [] }, stored)).toEqual(chatRuleDefaults());
    expect(chatRulesOf({ offers: [] }, "direct").offers).toEqual([]);
  });
});
