import { actsWithGuardianAccess } from "../guardian-access.js";
import type { PolicyInput } from "./policy/policy-engine.js";
import { decidePolicy } from "./policy/policy-engine.js";
import type { Addressed } from "../addressing.js";
import type { WakeGate, WakeMessage } from "./index.js";

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
  /** The account serves its whole workspace, so a message addressed to it
   *  wakes the agent whoever sent it. Absent, it does not. */
  servesWorkspace?: boolean;
}

/**
 * The guardian's chat settings and policies, applied in order: a chat switched
 * off stays quiet, so does another bot's message the chat does not take, a
 * message that mentions only others where the chat ignores those, and one
 * addressed to nobody in a chat that wakes only on a mention. Then a policy
 * block blocks. On an account that serves its workspace, a message
 * addressed to it wakes the agent then, whoever sent it. Otherwise a sender
 * below the reply-to levels stays quiet, a trusted sender or a policy allow
 * wakes the agent, and anyone else goes to review. A stranger reads as bond
 * level `other`.
 */
export function chatSettingsWake(settings: ChatWakeSettings): WakeGate {
  return (message, sender) => {
    if (!settings.enabled) return "quiet";
    if (message.fromBot) {
      if (settings.botMessages === "ignore") return "quiet";
      if (settings.botMessages === "mentions" && message.addressing !== "mention") return "quiet";
    }
    if (addressingRuleKeepsQuiet(message, settings)) return "quiet";
    const bondLevel = sender.person?.bondLevel ?? "other";
    const policy = decidePolicy(settings, {
      channel: message.channel,
      sender: sender.person,
      bondLevel,
      threadName: message.threadName,
      threadType: message.place === "direct" ? "private" : "group",
    });
    if (policy.action === "block") return "block";
    // Whoever may act with the guardian's access wakes the agent when they
    // address it. The guardian wakes by the levels below, as before.
    if (
      addressedOf(message) === "rome" &&
      actsWithGuardianAccess({
        servesWorkspace: settings.servesWorkspace === true,
        guardian: false,
      })
    ) {
      return "wake";
    }
    if (!settings.replyToLevels.includes(bondLevel)) return "quiet";
    if (settings.trustedLevels.includes(bondLevel) || policy.action === "allow") return "wake";
    return "review";
  };
}

/**
 * Whom `message` addresses, as the app passed it on: `rome` for a direct
 * message, a mention, a reply or a message in Rome's thread, `others` for one
 * that mentions only others, `nobody` for the rest. Undefined where the
 * connection could not tell.
 */
function addressedOf(message: WakeMessage): Addressed | undefined {
  switch (message.addressing) {
    case "direct":
    case "mention":
    case "reply":
    case "bot_thread":
      return "rome";
    case "ambient":
      return message.mentionsOthers ? "others" : "nobody";
    case undefined:
      return undefined;
    default: {
      const unknown: never = message.addressing;
      throw new Error(`unknown addressing ${String(unknown)}`);
    }
  }
}

/** Whether the chat's reply rule or its rule on mentions of others keeps
 *  `message` quiet. Where the connection could not tell whom it addresses,
 *  only a mention of others it reported can. */
function addressingRuleKeepsQuiet(
  message: WakeMessage,
  settings: Pick<ChatWakeSettings, "replyRule" | "whenOthersMentioned">,
): boolean {
  const addressed = addressedOf(message);
  if (addressed === undefined) {
    return message.mentionsOthers === true && settings.whenOthersMentioned === "ignore";
  }
  switch (addressed) {
    case "rome":
      return false;
    case "others":
      return settings.whenOthersMentioned === "ignore" || settings.replyRule === "mention";
    case "nobody":
      return settings.replyRule === "mention";
    default: {
      const unknown: never = addressed;
      throw new Error(`unknown addressing ${String(unknown)}`);
    }
  }
}
