// The chat rules a kind of connection declares, their defaults, and how a
// chat's value is worked out from them. Core runs them, and the dashboard's
// mock mode derives the same values from them.
// Vocabulary: docs/domains/chats.md#chat-rule.

import type {
  ChatSettings,
  ChatSettingsOverrides,
  ProviderSessionResetPolicy,
} from "@rome-os/app-runtime";

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

/** What a kind of connection declares about its chats' rules. A rule it
 *  neither offers nor fixes runs at Core's defaults. No rule is
 *  both offered and fixed. */
export interface KindChatRules {
  /** The rules a guardian may set on the kind's chats. */
  readonly offers: readonly ChatRuleName[];
  /** The values the kind's chats always run on, for rules it does not offer. */
  readonly fixed?: Readonly<Partial<ChatRules>>;
}

/** The values for a kind whose chats wake the agent on every message the
 *  platform delivers, whoever it addresses and whoever sent it. Kinds that
 *  offer none of the three state this as `fixed`. */
export const WAKES_ON_EVERY_MESSAGE = {
  "activation.mode": "all",
  "activation.botMessages": "all",
  "activation.whenOthersMentioned": "respond",
} as const satisfies Partial<ChatRules>;

/** A kind whose chats offer only when the session starts afresh, and wake on
 *  every message. */
export const SESSION_RESET_ONLY_CHAT_RULES: KindChatRules = {
  offers: ["session.reset"],
  fixed: WAKES_ON_EVERY_MESSAGE,
};

/** A self-created Discord bot offers every chat rule. */
export const DISCORD_CHAT_RULES: KindChatRules = {
  offers: [
    "enabled",
    "activation.mode",
    "activation.botMessages",
    "activation.whenOthersMentioned",
    "replies.placement",
    "routing.agentName",
    "session.reset",
  ],
};

/** A Feishu app offers every rule but the two on whose messages wake the
 *  agent: another bot's message and one addressed only to others wake it,
 *  as they did before kinds declared their rules. */
export const FEISHU_CHAT_RULES: KindChatRules = {
  offers: ["enabled", "activation.mode", "replies.placement", "routing.agentName", "session.reset"],
  fixed: {
    "activation.botMessages": WAKES_ON_EVERY_MESSAGE["activation.botMessages"],
    "activation.whenOthersMentioned": WAKES_ON_EVERY_MESSAGE["activation.whenOthersMentioned"],
  },
};

/** A WeChat chat can be switched off and given its own agent. It wakes on
 *  every message it hears. */
export const WECHAT_CHAT_RULES: KindChatRules = {
  offers: ["enabled", "routing.agentName", "session.reset"],
  fixed: WAKES_ON_EVERY_MESSAGE,
};

/** When a chat's session starts afresh where nobody set it: after a week
 *  with no message. */
const DEFAULT_SESSION_RESET = {
  mode: "idle",
  idleMinutes: 7 * 24 * 60,
} as const satisfies ProviderSessionResetPolicy;

/** The value of each rule nobody set and no kind fixed. */
export function chatRuleDefaults(): ChatRules {
  return {
    enabled: true,
    "activation.mode": "mention",
    "activation.botMessages": "ignore",
    "activation.whenOthersMentioned": "ignore",
    "replies.placement": "thread",
    "routing.agentName": null,
    "session.reset": structuredClone(DEFAULT_SESSION_RESET),
  };
}

/** The value `stored` holds for `rule`, or undefined where it holds none. */
export function storedRuleValue<R extends ChatRuleName>(
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
  for (const rule of Object.keys(effective) as ChatRuleName[]) {
    const fixed = rules.fixed?.[rule];
    if (fixed !== undefined) {
      set(rule, fixed);
    } else if (rules.offers.includes(rule)) {
      set(rule, storedRuleValue(stored, rule));
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
