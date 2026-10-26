// The agent linked to a channel, as the channel-message hook reads it: the
// agent of the connected account behind the channel's connection.
// Vocabulary: docs/domains/chats.md#connected-account. Invariants:
// docs/architecture/channels.md#an-accounts-agent.

import type { ChannelMessageHookDeps, ChatSettingsSnapshot } from "@rome-os/app-runtime";
import { isCoreMainAgentId } from "../apps/artifact-id.js";
import type { AccountLink } from "@rome/api-types/account-agents";
import type { ChannelRecordsRepository } from "../db/repositories/channel-records.js";
import {
  ConnectedAccountNotFound,
  type ConnectedAccountsRepository,
} from "../db/repositories/connected-accounts.js";
import { createLogger } from "../logger.js";
import type { AccountLinkOf } from "./account-links.js";
import type { InboundListening } from "./connection-ports.js";

const log = createLogger("account-agents");

/** Where a channel's agent is read: the channel's record names its
 *  connection, and the connection's connected account holds the agent. */
export interface ChannelAgents {
  records: Pick<ChannelRecordsRepository, "byId" | "linkOf">;
  accounts: Pick<ConnectedAccountsRepository, "agentOf">;
}

/** Whether channel `channel`'s kind of connection takes an agent, and the
 *  agent stored on its connected account, null for none or for a channel no connection backs.
 *  A connection kind's first channel carries the connection kind's name, so a
 *  channel with no record answers for its own connection kind. */
function storedAgent(
  { records, accounts }: ChannelAgents,
  channel: string,
): { takesAgent: boolean; agent: string | null } {
  const record = records.byId(channel);
  const connectionId = record?.connectionId ?? null;
  return {
    takesAgent: records.linkOf(record?.connectionKind ?? channel) !== null,
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
  const { takesAgent, agent } = storedAgent(sources, channelName);
  if (!takesAgent) return undefined;
  return agent !== null && (isCoreMainAgentId(agent) || agents.has(agent)) ? agent : null;
}

/**
 * Which accounts Rome listens to. An account of a connection kind that takes
 * an agent is listened to only while its record names an agent,
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
    const { takesAgent, agent } = storedAgent(this.sources, channel);
    if (!takesAgent) return true;
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
 * message. It answers undefined for a channel whose connection kind takes no
 * agent, the stored agent for a linked one, and null for one with
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

/** A link asked of a connected account whose kind of connection takes no
 *  agent. */
export class AccountNotLinkable extends Error {
  constructor(
    readonly connectionId: string,
    readonly connectionKind: string,
  ) {
    super(`A ${connectionKind} account cannot be linked to an agent`);
    this.name = "AccountNotLinkable";
  }
}

/** A connected account's agent as it stands after a link. */
export interface AccountLinked {
  connectionId: string;
  agent: string | null;
  link: AccountLink | null;
}

/**
 * Link `agent` to the connected account of connection `connectionId`, or
 * unlink it with null, and return its agent as it now stands. Only that
 * account changes. Only an account whose kind of connection takes an agent
 * takes a link, and unlinking is always open. `kindOf` names the kind of a
 * connection Rome holds, or null for none. Throws
 * {@link ConnectedAccountNotFound} when Rome holds no such connection, and
 * {@link AccountNotLinkable} for a kind that takes no agent.
 */
export function linkAccountAgent(
  kindOf: (connectionId: string) => string | null,
  linkOf: AccountLinkOf,
  accounts: Pick<ConnectedAccountsRepository, "link">,
  connectionId: string,
  agent: string | null,
): AccountLinked {
  const kind = kindOf(connectionId);
  if (kind === null) throw new ConnectedAccountNotFound(connectionId);
  const link = linkOf(kind);
  if (agent !== null && link === null) throw new AccountNotLinkable(connectionId, kind);
  return { connectionId, agent: accounts.link(connectionId, agent), link };
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
