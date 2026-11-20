import type { PolicyInput } from "./policy/policy-engine.js";
import { decidePolicy } from "./policy/policy-engine.js";
import type { WakeGate } from "./index.js";

/** The settings `chatSettingsWake` decides from. */
export interface ChatWakeSettings extends PolicyInput {
  /** The chat is switched on. */
  enabled: boolean;
  /** The chat's reply rule: wake on every message, or only on one addressed
   *  to Rome's account. */
  replyRule: "mention" | "all";
  /** Whether another bot's message may wake the agent: never, only when it
   *  mentions Rome's account, or as anyone's would. */
  botMessages: "ignore" | "mentions" | "all";
  /** Whether a message that mentions only others may wake the agent. */
  whenOthersMentioned: "ignore" | "respond";
  /** The bond levels the agent replies to. Anyone else stays quiet. */
  replyToLevels: readonly string[];
}

/**
 * The guardian's chat settings and policies, applied in order: a chat switched
 * off stays quiet, so does another bot's message the chat does not take, a
 * message that mentions only others where the chat ignores those, and one
 * addressed to nobody in a chat that wakes only on a mention. Then a policy
 * block blocks, a sender below the reply-to levels
 * stays quiet, a trusted sender or a policy allow wakes the agent, and anyone
 * else goes to review. A stranger reads as bond level `other`.
 */
export function chatSettingsWake(settings: ChatWakeSettings): WakeGate {
  return (message, sender) => {
    if (!settings.enabled) return "quiet";
    if (message.fromBot) {
      if (settings.botMessages === "ignore") return "quiet";
      if (settings.botMessages === "mentions" && message.addressing !== "mention") return "quiet";
    }
    if (message.mentionsOthers && settings.whenOthersMentioned === "ignore") return "quiet";
    if (settings.replyRule === "mention" && message.addressing === "ambient") return "quiet";
    const bondLevel = sender.person?.bondLevel ?? "other";
    const policy = decidePolicy(settings, {
      channel: message.channel,
      sender: sender.person,
      bondLevel,
      threadName: message.threadName,
      threadType: message.place === "direct" ? "private" : "group",
    });
    if (policy.action === "block") return "block";
    if (!settings.replyToLevels.includes(bondLevel)) return "quiet";
    if (settings.trustedLevels.includes(bondLevel) || policy.action === "allow") return "wake";
    return "review";
  };
}
