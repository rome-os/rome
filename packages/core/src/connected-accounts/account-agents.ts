// The agent of each of Rome's connected accounts, as the inbound ports and
// the channel-message hook read it, by the connection's id.
// Vocabulary: docs/domains/chats.md#connected-account. Invariants:
// docs/architecture/channels.md#an-accounts-agent.

import type { Account, ChatSettingsSnapshot } from "@rome-os/app-runtime";
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
import { isAccount, type RomeAccounts } from "./rome-accounts.js";

const log = createLogger("account-agents");

/** Where an account's agent is read: the kind of each connection Rome holds,
 *  which says whether its account takes an agent, and the connected account
 *  that holds the agent. */
export interface AccountAgents {
  /** The kind of connection `connectionId`, or null when Rome holds none. */
  kindOf: (connectionId: string) => string | null;
  linkOf: AccountLinkOf;
  accounts: Pick<ConnectedAccountsRepository, "agentOf">;
}

/** Whether connection `connectionId`'s account takes an agent, and the agent
 *  stored on its connected account, null for none. A connection Rome does not
 *  hold takes none. */
function storedAgent(
  { kindOf, linkOf, accounts }: AccountAgents,
  connectionId: string,
): { takesAgent: boolean; agent: string | null } {
  const kind = kindOf(connectionId);
  return {
    takesAgent: kind !== null && linkOf(kind) !== null,
    agent: accounts.agentOf(connectionId),
  };
}

/**
 * The answer `accountAgentResolver` gives for connection `connectionId`, read
 * with no logging and no state, for read-only callers such as the sessions
 * explorer.
 */
export function readAccountAgent(
  sources: AccountAgents,
  agents: { has(name: string): boolean },
  connectionId: string,
): string | null | undefined {
  const { takesAgent, agent } = storedAgent(sources, connectionId);
  if (!takesAgent) return undefined;
  return agent !== null && (isCoreMainAgentId(agent) || agents.has(agent)) ? agent : null;
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
 * Which accounts Rome listens to, by connection id. An account whose kind of
 * connection takes an agent is listened to only while its connected account
 * names an agent, loaded or not; an account of any other kind always is.
 *
 * Call `changed` after each write to an account's agent, naming every
 * connection the write touched, so its inbound port starts or stops listening.
 */
export class AccountListening implements InboundListening {
  private readonly listeners = new Set<(connectionId: string) => void>();

  constructor(private readonly sources: AccountAgents) {}

  listens(connectionId: string): boolean {
    const { takesAgent, agent } = storedAgent(this.sources, connectionId);
    if (!takesAgent) return true;
    return agent !== null;
  }

  onChange(listener: (connectionId: string) => void): void {
    this.listeners.add(listener);
  }

  /** Called after the link is saved, so a port that fails to follow it is
   *  logged rather than failing the link or skipping the other ports. */
  changed(connectionIds: Iterable<string>): void {
    for (const connectionId of connectionIds) {
      for (const listener of this.listeners) {
        try {
          listener(connectionId);
        } catch (error) {
          log.warn("an inbound port did not follow its account's agent", { connectionId, error });
        }
      }
    }
  }
}

/**
 * The agent of connection `connectionId`'s account, read on each call, so a
 * switched agent is right on the next message. It answers undefined for an
 * account whose kind of connection takes no agent, the stored agent for a
 * linked one, and null for one with no agent or whose agent is not loaded.
 * Each silent state logs once per connection until the account answers again:
 * an account with no agent at info, since a newly added one starts that way,
 * and one whose agent is not loaded as a warning.
 */
export function accountAgentResolver(
  sources: AccountAgents,
  agents: { has(name: string): boolean },
): (connectionId: string) => string | null | undefined {
  const silent = new Map<string, string | null>();
  return (connectionId) => {
    const answering = readAccountAgent(sources, agents, connectionId);
    if (answering !== null) {
      silent.delete(connectionId);
      return answering;
    }
    const { agent } = storedAgent(sources, connectionId);
    if (silent.has(connectionId) && silent.get(connectionId) === agent) return null;
    silent.set(connectionId, agent);
    if (agent === null) {
      log.info("account has no agent; Rome does not listen to it until one is linked", {
        connectionId,
      });
    } else {
      log.warn("account's agent is not loaded; the account stays silent", {
        connectionId,
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
