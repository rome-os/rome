// The agent linked to a channel, as the channel-message hook reads it.
// Vocabulary: docs/concepts/messaging.md#channels. Invariants:
// docs/architecture/channels.md#linked-agents.

import type { ChannelMessageHookDeps, ConversationSettingsSnapshot } from "@rome-os/app-runtime";
import { LINKABLE_SERVICES } from "@rome/api-types/linked-agents";
import { isCoreMainAgentId } from "../apps/artifact-id.js";
import type { ChannelRecordsRepository } from "../db/repositories/channel-records.js";
import { createLogger } from "../logger.js";

const log = createLogger("linked-agents");

/**
 * The hook's `linkedAgentOf`, reading the channel's record on each call, so a
 * relink, or a channel whose record lands after wiring, is right on the next
 * message. It answers undefined for a channel whose service is outside
 * `LINKABLE_SERVICES`, the stored agent for a linked one, and null for one with
 * no agent or whose agent is not loaded. Each silent state logs once per
 * channel until the channel answers again: an account with no linked agent at
 * info, since a newly added one starts that way, and one whose agent is not
 * loaded as a warning.
 */
export function linkedAgentResolver(
  records: Pick<ChannelRecordsRepository, "byId">,
  agents: { has(name: string): boolean },
): NonNullable<ChannelMessageHookDeps["linkedAgentOf"]> {
  const silent = new Map<string, string | null>();
  return (channelName) => {
    const record = records.byId(channelName);
    // A service's first channel carries the service's name, so a channel with
    // no record answers for its own service.
    if (!LINKABLE_SERVICES.has(record?.service ?? channelName)) return undefined;
    const agent = record?.agent ?? null;
    if (agent !== null && (isCoreMainAgentId(agent) || agents.has(agent))) {
      silent.delete(channelName);
      return agent;
    }
    if (silent.has(channelName) && silent.get(channelName) === agent) return null;
    silent.set(channelName, agent);
    if (agent === null) {
      log.info("account has no linked agent; it stays silent until one is linked", {
        channel: channelName,
      });
    } else {
      log.warn("linked agent is not loaded; the account stays silent", {
        channel: channelName,
        agent,
      });
    }
    return null;
  };
}

/**
 * The agent that answers a conversation by the rules in
 * docs/architecture/channels.md#linked-agents, or null when none does. `linked`
 * is the {@link linkedAgentResolver} answer for the conversation's channel, and
 * `choice` the conversation's stored agent, "main" for a pin to main. Main reads
 * as "main". A choice whose agent is not loaded still reads as the choice.
 */
export function answeringAgentOf(
  linked: string | null | undefined,
  choice: string | undefined,
  threadType: "private" | "group",
): string | null {
  if (linked === null) return null;
  const agent =
    (linked !== undefined && threadType === "private" ? undefined : choice) ?? linked ?? "main";
  return isCoreMainAgentId(agent) ? "main" : agent;
}

/** The conversation's stored agent as {@link answeringAgentOf} takes it. A pin
 *  to main can be stored as a null override, apart from no choice at all. */
export function storedAgentChoice(
  snapshot: Pick<ConversationSettingsSnapshot, "effective" | "overrides">,
): string | undefined {
  return snapshot.overrides.routing?.agentName === null
    ? "main"
    : (snapshot.effective.routing.agentName ?? undefined);
}

/** How an in-chat settings reply names the {@link answeringAgentOf} result. */
export function describeAnsweringAgent(agent: string | null): string {
  return agent ?? "none (this bot has no linked agent, or it is not loaded)";
}
