import type { ApiConnection } from "@/lib/connections-api";
import { MAIN_AGENT_ID } from "@rome/api-types/account-agents";
import {
  asChatSettings,
  chatRuleDefaults,
  DISCORD_CHAT_RULES,
  effectiveChatRules,
  FEISHU_CHAT_RULES,
  type KindChatRules,
  SESSION_RESET_ONLY_CHAT_RULES,
} from "@rome/api-types/chat-rules";
import type { ChatSettings } from "@rome/api-types/chat-settings";

// What each kind of connection offers: the declarations core runs on.
const CHAT_RULES: Record<string, KindChatRules> = {
  discord: DISCORD_CHAT_RULES,
  feishu: FEISHU_CHAT_RULES,
  telegram: SESSION_RESET_ONLY_CHAT_RULES,
  email: SESSION_RESET_ONLY_CHAT_RULES,
  whatsapp: SESSION_RESET_ONLY_CHAT_RULES,
  linkedin: SESSION_RESET_ONLY_CHAT_RULES,
};

/** The values a chat runs on where nobody set one and no kind fixed one. */
export const CHAT_RULE_DEFAULTS: ChatSettings = asChatSettings(chatRuleDefaults());

/** What a group chat of the kind `connectionKind` runs on where nobody set
 *  a value, worked out as core works it out. */
export function chatRuleDefaultsOf(connectionKind: string): ChatSettings {
  const kind = CHAT_RULES[connectionKind] ?? SESSION_RESET_ONLY_CHAT_RULES;
  return asChatSettings(effectiveChatRules(kind, {}));
}

/** A kind's connection fields for its chat rules: what it offers, and what
 *  its group chats run on where nobody set a value. */
function chatRuleFields(
  kind: KindChatRules | undefined,
): Pick<ApiConnection, "chatRules" | "chatRuleDefaults"> {
  if (!kind) return { chatRules: [], chatRuleDefaults: null };
  return {
    chatRules: [...kind.offers],
    chatRuleDefaults: asChatSettings(effectiveChatRules(kind, {})),
  };
}

// The connection ledger. In its own module because two surfaces read it and one
// of them writes it: the Connections page revokes a grant, and the send routes
// behind that channel have to notice. Keeping it in `index.ts` would have meant
// `people.ts` importing the module that imports it.
//
// Every card reads its state from `state`, never from `capabilities`: a
// connection with no state renders "Not connected" however unlocked its
// capabilities claim to be. Each entry below therefore carries the working
// state its ceremony would have left, or the Connections page would contradict
// the surfaces these fixtures feed: the WhatsApp contacts, and the configured
// Discord and Telegram conversations below.
export const connections: { connections: ApiConnection[] } = {
  connections: [
    {
      id: "github-demo",
      connectionKind: "github",
      label: "GitHub · Rome Demo",
      state: "working",
      grants: { user: "authorized" },
      display: {
        user: { displayName: "Rome Demo", handle: "rome-demo", email: null, avatarUrl: null },
      },
      capabilities: {
        chat: { state: "unsupported" },
        act: { state: "unlocked" },
        watch: { state: "unlocked" },
      },
      connect: null,
      setups: {},
      channel: null,
      agent: null,
      link: null,
      severalAccounts: false,
      chatRules: [],
    },
    ...[
      {
        service: "email",
        label: "Email",
        grant: "inbox",
        email: "guardian@example.com",
        severalAccounts: false,
      },
      { service: "feishu", label: "Feishu", grant: "bot", email: null, severalAccounts: true },
    ].map(
      ({ service, label, grant, email, severalAccounts }): ApiConnection => ({
        id: `${service}-demo`,
        connectionKind: service,
        label: `${label} · Rome Demo`,
        state: "working",
        grants: { [grant]: "authorized" },
        display: {
          [grant]: { displayName: "Rome Demo", handle: null, email, avatarUrl: null },
        },
        capabilities: {
          chat: { state: "unlocked" },
          act: { state: "unsupported" },
          watch: { state: "unsupported" },
        },
        connect: null,
        setups: {},
        channel: service,
        // Core links main to every existing linkable bot on upgrade.
        agent: service === "feishu" ? MAIN_AGENT_ID : null,
        link: service === "feishu" ? "own_account" : null,
        severalAccounts,
        ...chatRuleFields(CHAT_RULES[service]),
      }),
    ),
    {
      id: "discord-1",
      connectionKind: "discord",
      label: "Discord · Rome",
      state: "working",
      grants: { bot: "authorized" },
      display: {
        bot: { displayName: "Rome", handle: "rome#4417", email: null, avatarUrl: null },
      },
      capabilities: {
        chat: { state: "unlocked" },
        act: { state: "unsupported" },
        watch: { state: "unsupported" },
      },
      connect: null,
      setups: {},
      channel: "discord",
      platform: "discord",
      account: { platform: "discord", id: "100000000000000001" },
      agent: MAIN_AGENT_ID,
      link: "own_account",
      severalAccounts: true,
      ...chatRuleFields(CHAT_RULES.discord),
    },
    {
      id: "discord-app-1",
      connectionKind: "discord_app",
      label: "Discord · Rome",
      state: "working",
      grants: { bot: "authorized" },
      display: {
        bot: { displayName: "Rome", handle: null, email: null, avatarUrl: null },
      },
      capabilities: {
        chat: { state: "unlocked" },
        act: { state: "unsupported" },
        watch: { state: "unsupported" },
      },
      connect: null,
      setups: {},
      channel: "discord_app",
      platform: "discord",
      account: { platform: "discord", id: "100000000000000099" },
      agent: "core:concierge",
      link: "own_account",
    },
    {
      id: "telegram-1",
      connectionKind: "telegram",
      label: "Telegram · Rome",
      state: "working",
      grants: { bot: "authorized" },
      display: {
        bot: { displayName: "Rome", handle: "@rome_guardian_bot", email: null, avatarUrl: null },
      },
      capabilities: {
        chat: { state: "unlocked" },
        act: { state: "unsupported" },
        watch: { state: "unsupported" },
      },
      connect: null,
      setups: {},
      channel: "telegram",
      platform: "telegram",
      account: { platform: "telegram", id: "7000000001" },
      agent: MAIN_AGENT_ID,
      link: "own_account",
      severalAccounts: true,
      ...chatRuleFields(CHAT_RULES.telegram),
    },
    {
      // The channel behind the WhatsApp contacts: the address-book
      // mirror those contacts come from only exists while a session is linked,
      // so dropping this entry would leave the two surfaces disagreeing about
      // whether WhatsApp is connected at all.
      id: "whatsapp-1",
      connectionKind: "whatsapp",
      label: "WhatsApp · Rome",
      state: "working",
      grants: { session: "authorized" },
      display: {
        session: { displayName: "Rome", handle: "+1 (415) 555-0100", email: null, avatarUrl: null },
      },
      capabilities: {
        chat: { state: "unlocked" },
        act: { state: "unsupported" },
        watch: { state: "unsupported" },
      },
      connect: null,
      setups: {},
      channel: "whatsapp",
      agent: null,
      link: null,
      severalAccounts: false,
      ...chatRuleFields(CHAT_RULES.whatsapp),
    },
    {
      id: "linkedin-1",
      connectionKind: "linkedin",
      label: "LinkedIn · Rome",
      state: "working",
      grants: { session: "authorized" },
      display: {
        session: { displayName: "Rome", handle: "rome-guardian", email: null, avatarUrl: null },
      },
      capabilities: {
        chat: { state: "unlocked" },
        act: { state: "unsupported" },
        watch: { state: "unsupported" },
      },
      connect: null,
      setups: {},
      channel: "linkedin",
      agent: null,
      link: null,
      severalAccounts: false,
      ...chatRuleFields(CHAT_RULES.linkedin),
    },
    // The OAuth services this host offers but nobody has connected. Core lists
    // them as placeholders (`id: null`), so the page has something to offer.
    ...[
      { service: "google", grant: "user" },
      { service: "microsoft", grant: "user" },
      { service: "slack", grant: "workspace" },
      { service: "shopify", grant: "store" },
    ].map(
      ({ service, grant }): ApiConnection => ({
        id: null,
        connectionKind: service,
        label: service,
        state: null,
        grants: { [grant]: "unauthorized" },
        display: { [grant]: null },
        capabilities: {
          chat: { state: "unsupported" },
          act: { state: "needs-auth", missingGrants: [grant] },
          watch: { state: "unsupported" },
        },
        connect: {
          url: `https://example.com/oauth/${service}`,
          available: true,
          unavailableReason: null,
        },
        setups: {},
        channel: null,
        agent: null,
        link: null,
        severalAccounts: false,
      }),
    ),
  ],
};

/**
 * The talk transports a service currently has, mirroring the `talkRouter.list()`
 * filter the send routes run. A revoked grant relocks `talk`, so a disconnected
 * channel drops out of this list and its send route refuses, the way the real
 * one does.
 */
export function talkConnections(service: string): ApiConnection[] {
  return connections.connections.filter(
    (connection) =>
      connection.connectionKind === service && connection.capabilities.chat.state === "unlocked",
  );
}
