import type { PolicyInput } from "./policy/policy-engine.js";
import { decidePolicy } from "./policy/policy-engine.js";
import type { WakeGate } from "./index.js";

/** The settings `chatSettingsWake` decides from. */
export interface ChatWakeSettings extends PolicyInput {
  /** The chat is switched on. */
  enabled: boolean;
  /** The bond levels the agent replies to. Anyone else stays quiet. */
  replyToLevels: readonly string[];
}

/**
 * The guardian's chat settings and policies, applied in order: a chat switched
 * off stays quiet, a policy block blocks, a sender below the reply-to levels
 * stays quiet, a trusted sender or a policy allow wakes the agent, and anyone
 * else goes to review. A stranger reads as bond level `other`.
 */
export function chatSettingsWake(settings: ChatWakeSettings): WakeGate {
  return (message, sender) => {
    if (!settings.enabled) return "quiet";
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
