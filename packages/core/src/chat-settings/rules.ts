// The chat rules: what a guardian can set on one chat, the value each takes
// when nobody set it, and how Core works out the value a chat runs on. Core
// owns the set. A kind of connection only says which rules its chats offer,
// and which values it fixes for the rest; the kinds' declarations live in
// @rome/api-types/chat-rules so the dashboard's mock mode reads the same
// ones. Vocabulary:
// docs/domains/chats.md#chat-rule.

import {
  CONVERSATION_SETTING_FIELDS,
  type ChatSettingField,
  type ChatSettings,
  type ChatSettingsOverrides,
  type ProviderSessionResetPolicy,
} from "@rome-os/app-runtime";
import {
  type ChatRuleName,
  type ChatRules,
  type KindChatRules,
  SESSION_RESET_ONLY_CHAT_RULES,
  WAKES_ON_EVERY_MESSAGE,
} from "@rome/api-types/chat-rules";
import { DEFAULT_PROVIDER_SESSION_RESET_POLICY } from "./reset-policy.js";

export {
  type ChatRuleName,
  type ChatRules,
  type KindChatRules,
  WAKES_ON_EVERY_MESSAGE,
} from "@rome/api-types/chat-rules";

/** Every chat rule, in the order the dashboard lists them: the stored
 *  fields, in the order the app SDK declares them. */
export const CHAT_RULE_NAMES: readonly ChatRuleName[] = CONVERSATION_SETTING_FIELDS;

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

/** The rules of a chat whose kind Rome has not registered or that declares
 *  none, such as Rome's own webchat: only the session reset, waking on every
 *  message, as every kind outside the old table ran before kinds declared
 *  their rules. Every kind that hears messages declares its own. */
export const UNDECLARED_CHAT_RULES: KindChatRules = SESSION_RESET_ONLY_CHAT_RULES;

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

// The rule names are the stored fields, so a field added to one without the
// other fails to compile here.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const namesAreStoredFields: Same<ChatRuleName, ChatSettingField> = true;
void namesAreStoredFields;
