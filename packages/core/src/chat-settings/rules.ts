// The chat rules: what a guardian can set on one chat. Core owns the set and
// is the one place that runs it. A kind of connection only says which rules
// its chats offer, and which values it fixes for the rest. Those
// declarations, the defaults, and how a chat's value is worked out live in
// @rome/api-types/chat-rules, so the dashboard's mock mode derives the same
// values. Vocabulary: docs/domains/chats.md#chat-rule.

import { CONVERSATION_SETTING_FIELDS, type ChatSettingField } from "@rome-os/app-runtime";
import {
  type ChatRuleName,
  type ChatRules,
  type KindChatRules,
  SESSION_RESET_ONLY_CHAT_RULES,
  WAKES_ON_EVERY_MESSAGE,
} from "@rome/api-types/chat-rules";

export {
  asChatSettings,
  type ChatRuleName,
  type ChatRules,
  chatRuleDefaults,
  effectiveChatRules,
  type KindChatRules,
  storedRuleValue,
  WAKES_ON_EVERY_MESSAGE,
} from "@rome/api-types/chat-rules";

/** Every chat rule, in the order the dashboard lists them: the stored
 *  fields, in the order the app SDK declares them. */
export const CHAT_RULE_NAMES: readonly ChatRuleName[] = CONVERSATION_SETTING_FIELDS;

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

// The rule names are the stored fields, so a field added to one without the
// other fails to compile here.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const namesAreStoredFields: Same<ChatRuleName, ChatSettingField> = true;
void namesAreStoredFields;
