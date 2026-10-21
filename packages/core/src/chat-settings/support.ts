import type { ChatSettingField, ChatSettings } from "@rome-os/app-runtime";
import { DEFAULT_PROVIDER_SESSION_RESET_POLICY } from "./reset-policy.js";

export const defaultConversationSettings = (): ChatSettings => ({
  enabled: true,
  activation: {
    mode: "mention",
    botMessages: "ignore",
    whenOthersMentioned: "ignore",
  },
  replies: { placement: "thread" },
  routing: { agentName: null },
  session: { reset: structuredClone(DEFAULT_PROVIDER_SESSION_RESET_POLICY) },
});

/** Fields every provider supports. Direct messages own only these. */
export const CORE_CONVERSATION_SETTING_FIELDS: readonly ChatSettingField[] = ["session.reset"];

/** The fields each provider enforces. Unlisted providers get the core fields. */
export const CONVERSATION_SETTING_FIELDS_BY_KIND: ReadonlyMap<string, readonly ChatSettingField[]> =
  new Map<string, readonly ChatSettingField[]>([
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
    // Admission and agent routing are enforced by the shared inbox hook,
    // independent of provider-native group policy or reply placement.
    ["wechat", ["enabled", "routing.agentName", "session.reset"]],
  ]);
