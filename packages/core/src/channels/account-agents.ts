// The agent linked to a channel, as the channel-message hook reads it: the
// agent of the connected account behind the channel's connection.
// Vocabulary: docs/domains/chats.md#connected-account. Invariants:
// docs/architecture/channels.md#an-accounts-agent.

import type { ChannelMessageHookDeps, ChatSettingsSnapshot } from "@rome-os/app-runtime";
import { LINKABLE_KINDS } from "@rome/api-types/account-agents";
import { isCoreMainAgentId } from "../apps/artifact-id.js";
import {
  ChannelNotLinkable,
  ChannelRecordNotFound,
  ChannelUnbacked,
  type ChannelRecord,
  type ChannelRecordsRepository,
} from "../db/repositories/channel-records.js";
import {
  ConnectedAccountNotFound,
  type ConnectedAccountsRepository,
} from "../db/repositories/connected-accounts.js";
import { createLogger } from "../logger.js";
import type { InboundListening } from "./connection-ports.js";

const log = createLogger("account-agents");

/** Where a channel's agent is read: the channel's record names its
 *  connection, and the connection's connected account holds the agent. */
export interface ChannelAgents {
  records: Pick<ChannelRecordsRepository, "byId">;
  accounts: Pick<ConnectedAccountsRepository, "agentOf">;
}

/** The connection kind channel `channel` belongs to, and the agent stored on
 *  its connected account, null for none or for a channel no connection backs.
 *  A connection kind's first channel carries the connection kind's name, so a
 *  channel with no record answers for its own connection kind. */
function storedAgent(
  { records, accounts }: ChannelAgents,
  channel: string,
): { connectionKind: string; agent: string | null } {
  const record = records.byId(channel);
  const connectionId = record?.connectionId ?? null;
  return {
    connectionKind: record?.connectionKind ?? channel,
    agent: connectionId === null ? null : accounts.agentOf(connectionId),
  };
}

/**
 * The answer `accountAgentResolver` gives for the channel, read with no logging
 * and no state, for read-only callers such as the sessions explorer.
 */
export function readAccountAgent(
  sources: ChannelAgents,
  agents: { has(name: string): boolean },
  channelName: string,
): string | null | undefined {
  const { connectionKind, agent } = storedAgent(sources, channelName);
  if (!LINKABLE_KINDS.has(connectionKind)) return undefined;
  return agent !== null && (isCoreMainAgentId(agent) || agents.has(agent)) ? agent : null;
}

/**
 * Which accounts Rome listens to. An account of a connection kind in
 * `LINKABLE_KINDS` is listened to only while its record names an agent,
 * loaded or not; an account of any other connection kind always is. A channel with
 * no record answers for its own connection kind, as in {@link readAccountAgent}.
 *
 * Call `changed` after each write to an account's agent, naming every account
 * the write touched, so its inbound port starts or stops listening.
 */
export class AccountListening implements InboundListening {
  private readonly listeners = new Set<(channel: string) => void>();

  constructor(private readonly sources: ChannelAgents) {}

  listens(channel: string): boolean {
    const { connectionKind, agent } = storedAgent(this.sources, channel);
    if (!LINKABLE_KINDS.has(connectionKind)) return true;
    return agent !== null;
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
 * message. It answers undefined for a channel whose connection kind is outside
 * `LINKABLE_KINDS`, the stored agent for a linked one, and null for one with
 * no agent or whose agent is not loaded. Each silent state logs once per
 * channel until the channel answers again: an account with no agent at
 * info, since a newly added one starts that way, and one whose agent is not
 * loaded as a warning.
 */
export function accountAgentResolver(
  sources: ChannelAgents,
  agents: { has(name: string): boolean },
): NonNullable<ChannelMessageHookDeps["accountAgentOf"]> {
  const silent = new Map<string, string | null>();
  return (channelName) => {
    const answering = readAccountAgent(sources, agents, channelName);
    if (answering !== null) {
      silent.delete(channelName);
      return answering;
    }
    const { agent } = storedAgent(sources, channelName);
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

/** A link asked of channel `channel`. */
export interface ChannelLink {
  channel: ChannelRecord;
  agent: string | null;
}

/**
 * Link `agent` to the account channel `id` stands for, or unlink it with
 * null, and return the channel with its agent as it now stands. The link is
 * stored on the connected account of the connection behind the channel, so
 * only that account changes. Only a channel of a linkable connection kind
 * takes a link, and only while a connection backs it. Unlinking is always
 * open, and a channel no connection backs already has no agent.
 */
export function linkChannelAgent(
  records: Pick<ChannelRecordsRepository, "byId">,
  accounts: Pick<ConnectedAccountsRepository, "link">,
  id: string,
  agent: string | null,
): ChannelLink {
  const channel = records.byId(id);
  if (!channel) throw new ChannelRecordNotFound(id);
  if (agent !== null && !LINKABLE_KINDS.has(channel.connectionKind)) {
    throw new ChannelNotLinkable(id, channel.connectionKind);
  }
  if (channel.connectionId === null) {
    if (agent !== null) throw new ChannelUnbacked(id);
    return { channel, agent: null };
  }
  try {
    return { channel, agent: accounts.link(channel.connectionId, agent) };
  } catch (error) {
    // The connection went between the read and the link.
    if (error instanceof ConnectedAccountNotFound) throw new ChannelUnbacked(id);
    throw error;
  }
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
