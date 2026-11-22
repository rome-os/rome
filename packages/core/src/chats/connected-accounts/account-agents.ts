// The agent of each of Rome's connected accounts, as the inbound ports and
// the channel-message hook read it, by the connection's id. The kind of
// connection decides it: nobody picks an account's agent.
// Vocabulary: docs/domains/chats.md#connected-account. Invariants:
// docs/architecture/channels.md#an-accounts-agent.

import type { AgentCatalog } from "../../agent/index.js";
import type { Account, ChatSettingsSnapshot } from "@rome-os/app-runtime";
import { isCoreMainAgentId } from "../../apps/artifact-id.js";
import type { ChannelRecordsRepository } from "../../db/repositories/channel-records.js";
import { createLogger } from "../../logger.js";
import type { InboundListening } from "./connection-ports.js";
import { isAccount, type RomeAccounts } from "./rome-accounts.js";

const log = createLogger("account-agents");

/** Where an account's agent is read: the kind of each connection Rome holds,
 *  and the agent that answers on an account of each kind. */
export interface AccountAgents {
  /** The kind of connection `connectionId`, or null when Rome holds none. */
  kindOf: (connectionId: string) => string | null;
  /** The agent that answers on an account of `kind`, or null when that kind
   *  takes no agent. */
  agentOfKind: (kind: string) => string | null;
}

/** The agent of connection `connectionId`'s account, or null when its kind
 *  takes none or Rome holds no such connection. */
function kindAgent({ kindOf, agentOfKind }: AccountAgents, connectionId: string): string | null {
  const kind = kindOf(connectionId);
  return kind === null ? null : agentOfKind(kind);
}

/**
 * The answer `accountAgentResolver` gives for connection `connectionId`, read
 * with no logging and no state, for read-only callers such as the sessions
 * explorer.
 */
export function readAccountAgent(
  sources: AccountAgents,
  agents: Pick<AgentCatalog, "find">,
  connectionId: string,
): string | null | undefined {
  const agent = kindAgent(sources, connectionId);
  if (agent === null) return undefined;
  return isCoreMainAgentId(agent) || agents.find(agent) !== undefined ? agent : null;
}

/**
 * An agent reader keyed by connection id, asked by channel name, for callers
 * that still name an account by its channel: the sessions explorer, and a
 * channel-message hook from before accounts. A channel a connection backs answers for that
 * connection. One no connection backs answers null when its kind of
 * connection takes an agent, and undefined otherwise. A connection kind's
 * first channel carries the kind's name, so a channel with no record answers
 * for its own kind.
 */
export function byChannel(
  records: Pick<ChannelRecordsRepository, "byId" | "linkOf">,
  agentOf: (connectionId: string) => string | null | undefined,
): (channel: string) => string | null | undefined {
  return (channel) => {
    const record = records.byId(channel);
    if (record?.connectionId) return agentOf(record.connectionId);
    return records.linkOf(record?.connectionKind ?? channel) === null ? undefined : null;
  };
}

/**
 * An agent reader keyed by connection id, asked by account, for the
 * channel-message hook. An account no connection of Rome's reaches answers
 * null, so nothing answers on it. A channel's name, which a hook from before
 * accounts passes, is answered by `channelAgentOf`.
 */
export function byAccount(
  accounts: Pick<RomeAccounts, "holderOf">,
  agentOf: (connectionId: string) => string | null | undefined,
  channelAgentOf: (channel: string) => string | null | undefined,
): (target: Account | string) => string | null | undefined {
  return (target) => {
    if (!isAccount(target)) return channelAgentOf(target);
    const connectionId = accounts.holderOf(target);
    return connectionId ? agentOf(connectionId) : null;
  };
}

/**
 * Which accounts Rome listens to, by connection id. Every account is, since
 * the kind of connection decides each account's agent. The inbound ports
 * still ask, until they stop reading it.
 */
export class AccountListening implements InboundListening {
  listens(_connectionId: string): boolean {
    return true;
  }

  onChange(_listener: (connectionId: string) => void): void {}
}

/**
 * The agent of connection `connectionId`'s account. It answers undefined for
 * an account whose kind of connection takes no agent, the kind's agent for
 * one that takes one, and null when that agent is not loaded, which logs a
 * warning once per connection until it answers again.
 */
export function accountAgentResolver(
  sources: AccountAgents,
  agents: Pick<AgentCatalog, "find">,
): (connectionId: string) => string | null | undefined {
  const silent = new Set<string>();
  return (connectionId) => {
    const answering = readAccountAgent(sources, agents, connectionId);
    if (answering !== null) {
      silent.delete(connectionId);
      return answering;
    }
    if (silent.has(connectionId)) return null;
    silent.add(connectionId);
    log.warn("account's agent is not loaded; the account stays silent", {
      connectionId,
      agent: kindAgent(sources, connectionId),
    });
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
