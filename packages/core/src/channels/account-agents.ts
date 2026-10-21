// The agent linked to a channel, as the channel-message hook reads it.
// Vocabulary: docs/domains/chats.md#account. Invariants:
// docs/architecture/channels.md#an-accounts-agent.

import type { ChannelMessageHookDeps, ChatSettingsSnapshot } from "@rome-os/app-runtime";
import { LINKABLE_SERVICES } from "@rome/api-types/account-agents";
import { isCoreMainAgentId } from "../apps/artifact-id.js";
import type { ChannelRecordsRepository } from "../db/repositories/channel-records.js";
import { createLogger } from "../logger.js";
import type { InboundListening } from "./connection-ports.js";

const log = createLogger("account-agents");

/**
 * The answer `accountAgentResolver` gives for the channel, read with no logging
 * and no state, for read-only callers such as the sessions explorer.
 */
export function readAccountAgent(
  records: Pick<ChannelRecordsRepository, "byId">,
  agents: { has(name: string): boolean },
  channelName: string,
): string | null | undefined {
  const record = records.byId(channelName);
  // A service's first channel carries the service's name, so a channel with
  // no record answers for its own service.
  if (!LINKABLE_SERVICES.has(record?.service ?? channelName)) return undefined;
  const agent = record?.agent ?? null;
  return agent !== null && (isCoreMainAgentId(agent) || agents.has(agent)) ? agent : null;
}

/**
 * Which accounts Rome listens to. An account of a service in
 * `LINKABLE_SERVICES` is listened to only while its record names an agent,
 * loaded or not; an account of any other service always is. A channel with
 * no record answers for its own service, as in {@link readAccountAgent}.
 *
 * Call `changed` after each write to an account's agent, naming every account
 * the write touched, so its inbound port starts or stops listening.
 */
export class AccountListening implements InboundListening {
  private readonly listeners = new Set<(channel: string) => void>();

  constructor(private readonly records: Pick<ChannelRecordsRepository, "byId">) {}

  listens(channel: string): boolean {
    const record = this.records.byId(channel);
    if (!LINKABLE_SERVICES.has(record?.service ?? channel)) return true;
    return (record?.agent ?? null) !== null;
  }

  onChange(listener: (channel: string) => void): void {
    this.listeners.add(listener);
  }

  /** Called after the link is saved, so a port that fails to follow it is
   *  logged rather than failing the link or skipping the other ports. */
  changed(channels: Iterable<string | null>): void {
    for (const channel of channels) {
      if (channel === null) continue;
      for (const listener of this.listeners) {
        try {
          listener(channel);
        } catch (error) {
          log.warn("a channel's inbound did not follow its account's agent", { channel, error });
        }
      }
    }
  }
}

/**
 * The hook's `accountAgentOf`, reading the channel's record on each call, so a
 * switched agent, or a channel whose record lands after wiring, is right on the next
 * message. It answers undefined for a channel whose service is outside
 * `LINKABLE_SERVICES`, the stored agent for a linked one, and null for one with
 * no agent or whose agent is not loaded. Each silent state logs once per
 * channel until the channel answers again: an account with no agent at
 * info, since a newly added one starts that way, and one whose agent is not
 * loaded as a warning.
 */
export function accountAgentResolver(
  records: Pick<ChannelRecordsRepository, "byId">,
  agents: { has(name: string): boolean },
): NonNullable<ChannelMessageHookDeps["accountAgentOf"]> {
  const silent = new Map<string, string | null>();
  return (channelName) => {
    const answering = readAccountAgent(records, agents, channelName);
    if (answering !== null) {
      silent.delete(channelName);
      return answering;
    }
    const agent = records.byId(channelName)?.agent ?? null;
    if (silent.has(channelName) && silent.get(channelName) === agent) return null;
    silent.set(channelName, agent);
    if (agent === null) {
      log.info("account has no agent; Rome does not listen to it until one is linked", {
        channel: channelName,
      });
    } else {
      log.warn("account's agent is not loaded; the account stays silent", {
        channel: channelName,
        agent,
      });
    }
    return null;
  };
}

/**
 * The agent that answers a conversation by the rules in
 * docs/architecture/channels.md#an-accounts-agent, or null when none does. `linked`
 * is the {@link accountAgentResolver} answer for the conversation's channel, and
 * `choice` the conversation's stored agent, "main" for a pin to main. Main reads
 * as "main". On a linked channel, a choice that `isLoaded` rejects reads as the
 * account's agent, as the message handler falls back to it. Without `isLoaded`,
 * every choice counts as loaded.
 */
export function answeringAgentOf(
  linked: string | null | undefined,
  choice: string | undefined,
  threadType: "private" | "group",
  isLoaded?: (agent: string) => boolean,
): string | null {
  if (linked === null) return null;
  const followsLink =
    linked !== undefined &&
    (threadType === "private" ||
      (choice !== undefined && !isCoreMainAgentId(choice) && isLoaded?.(choice) === false));
  const agent = (followsLink ? undefined : choice) ?? linked ?? "main";
  return isCoreMainAgentId(agent) ? "main" : agent;
}

/** The conversation's stored agent as {@link answeringAgentOf} takes it. A pin
 *  to main can be stored as a null override, apart from no choice at all. */
export function storedAgentChoice(
  snapshot: Pick<ChatSettingsSnapshot, "effective" | "overrides">,
): string | undefined {
  return snapshot.overrides.routing?.agentName === null
    ? "main"
    : (snapshot.effective.routing.agentName ?? undefined);
}

/** How an in-chat settings reply names the {@link answeringAgentOf} result. */
export function describeAnsweringAgent(agent: string | null): string {
  return agent ?? "none (this account has no agent, or it is not loaded)";
}
