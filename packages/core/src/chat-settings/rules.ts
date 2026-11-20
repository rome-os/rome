// The chat rules: what a guardian can set on one chat, the value each takes
// when nobody set it, and how Core works out the value a chat runs on. Core
// owns the set. A kind of connection only says which rules its chats offer,
// and which values it fixes for the rest. Vocabulary:
// docs/domains/chats.md#chat-rule.

import type {
  ChatSettingField,
  ChatSettings,
  ChatSettingsOverrides,
  ProviderSessionResetPolicy,
} from "@rome-os/app-runtime";
import { DEFAULT_PROVIDER_SESSION_RESET_POLICY } from "./reset-policy.js";

/** The value of each chat rule, by its name. The names are the stored
 *  fields of `ChatSettings`, so storage and the app SDK keep their shape. */
export interface ChatRules {
  /** The chat is switched on. */
  enabled: boolean;
  /** The reply rule: wake only on a message addressed to Rome's account
   *  (`mention`), or on every message (`all`). */
  "activation.mode": ChatSettings["activation"]["mode"];
  /** Whether another bot's message wakes the agent: never, only when
   *  addressed to Rome's account, or as anyone's would. */
  "activation.botMessages": ChatSettings["activation"]["botMessages"];
  /** Whether a message addressed only to others wakes the agent. */
  "activation.whenOthersMentioned": ChatSettings["activation"]["whenOthersMentioned"];
  /** Whether a reply opens a thread or goes inline. */
  "replies.placement": ChatSettings["replies"]["placement"];
  /** The agent that answers, or null for the account's agent. */
  "routing.agentName": string | null;
  /** When the chat's session starts afresh. */
  "session.reset": ProviderSessionResetPolicy;
}

export type ChatRuleName = keyof ChatRules;

/** Every chat rule, in the order the dashboard lists them. */
export const CHAT_RULE_NAMES = [
  "enabled",
  "activation.mode",
  "activation.botMessages",
  "activation.whenOthersMentioned",
  "replies.placement",
  "routing.agentName",
  "session.reset",
] as const satisfies readonly ChatRuleName[];

/** What a kind of connection declares about its chats' rules. A rule it
 *  neither offers nor fixes runs at {@link CHAT_RULE_DEFAULTS}. No rule is
 *  both offered and fixed. */
export interface KindChatRules {
  /** The rules a guardian may set on the kind's chats. */
  readonly offers: readonly ChatRuleName[];
  /** The values the kind's chats always run on, for rules it does not offer. */
  readonly fixed?: Readonly<Partial<ChatRules>>;
}

/** The value of each rule nobody set and no kind fixed. */
export function chatRuleDefaults(): ChatRules {
  return {
    enabled: true,
    "activation.mode": "mention",
    "activation.botMessages": "ignore",
    "activation.whenOthersMentioned": "ignore",
    "replies.placement": "thread",
    "routing.agentName": null,
    "session.reset": structuredClone(DEFAULT_PROVIDER_SESSION_RESET_POLICY),
  };
}

/** The values for a kind whose chats wake the agent on every message the
 *  platform delivers, whoever it addresses and whoever sent it. Kinds that
 *  offer none of the three state this as `fixed`. */
export const WAKES_ON_EVERY_MESSAGE = {
  "activation.mode": "all",
  "activation.botMessages": "all",
  "activation.whenOthersMentioned": "respond",
} as const satisfies Partial<ChatRules>;

/** The rules of a chat whose kind Rome has not registered or that declares
 *  none, such as Rome's own webchat: only the session reset, waking on every
 *  message, as every kind outside the old table ran before kinds declared
 *  their rules. Every kind that hears messages declares its own. */
export const UNDECLARED_CHAT_RULES: KindChatRules = {
  offers: ["session.reset"],
  fixed: WAKES_ON_EVERY_MESSAGE,
};

/** The rules a kind's group chats offer the guardian, in the order the
 *  dashboard lists them. */
export function offeredChatRules(kind: KindChatRules | undefined): ChatRuleName[] {
  const offers = (kind ?? UNDECLARED_CHAT_RULES).offers;
  return CHAT_RULE_NAMES.filter((rule) => offers.includes(rule));
}

/** The rules a direct message offers, whatever its kind: only when its
 *  session starts afresh. Every message in one is addressed to Rome's
 *  account, and another bot's message wakes the agent as anyone's would. */
const DIRECT_MESSAGE_OFFERS: readonly ChatRuleName[] = ["session.reset"];

/**
 * The rules one chat runs under: its kind's, narrowed in a direct message to
 * what a direct message offers, with the rest of the addressing rules fixed
 * to wake on every message.
 */
export function chatRulesOf(kind: KindChatRules, place: "direct" | "group"): KindChatRules {
  if (place === "group") return kind;
  const offers = kind.offers.filter((rule) => DIRECT_MESSAGE_OFFERS.includes(rule));
  const fixed: Partial<ChatRules> = { ...kind.fixed, ...WAKES_ON_EVERY_MESSAGE };
  for (const rule of offers) delete fixed[rule];
  return { offers, ...(Object.keys(fixed).length > 0 ? { fixed } : {}) };
}

/**
 * The value of each rule a chat runs on: the kind's fixed value, else what
 * the guardian stored if the kind offers the rule, else the default. A value
 * stored for a rule the kind does not offer is ignored.
 */
export function effectiveChatRules(rules: KindChatRules, stored: ChatSettingsOverrides): ChatRules {
  const effective = chatRuleDefaults();
  const set = <R extends ChatRuleName>(rule: R, value: ChatRules[R] | undefined) => {
    if (value !== undefined) effective[rule] = structuredClone(value);
  };
  for (const rule of CHAT_RULE_NAMES) {
    const fixed = rules.fixed?.[rule];
    if (fixed !== undefined) {
      set(rule, fixed);
    } else if (rules.offers.includes(rule)) {
      set(rule, storedValue(stored, rule));
    }
  }
  return effective;
}

/** `rules` in the nested shape `ChatSettings` stores and apps read. */
export function asChatSettings(rules: ChatRules): ChatSettings {
  return {
    enabled: rules.enabled,
    activation: {
      mode: rules["activation.mode"],
      botMessages: rules["activation.botMessages"],
      whenOthersMentioned: rules["activation.whenOthersMentioned"],
    },
    replies: { placement: rules["replies.placement"] },
    routing: { agentName: rules["routing.agentName"] },
    session: { reset: rules["session.reset"] },
  };
}

function storedValue<R extends ChatRuleName>(
  stored: ChatSettingsOverrides,
  rule: R,
): ChatRules[R] | undefined {
  const values: { [F in ChatRuleName]: ChatRules[F] | undefined } = {
    enabled: stored.enabled,
    "activation.mode": stored.activation?.mode,
    "activation.botMessages": stored.activation?.botMessages,
    "activation.whenOthersMentioned": stored.activation?.whenOthersMentioned,
    "replies.placement": stored.replies?.placement,
    "routing.agentName": stored.routing?.agentName,
    "session.reset": stored.session?.reset,
  };
  return values[rule];
}

// The rule names are the stored fields, so a field added to one without the
// other fails to compile here.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const namesAreStoredFields: Same<ChatRuleName, ChatSettingField> = true;
void namesAreStoredFields;
