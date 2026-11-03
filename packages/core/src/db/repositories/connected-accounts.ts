// Chats' record of each connected account and the agent that speaks through
// it. Vocabulary: docs/domains/chats.md#connected-account.

import { MAIN_AGENT_ID } from "@rome/api-types/account-agents";
import { eq } from "drizzle-orm";
import { isCoreMainAgentId } from "../../apps/artifact-id.js";
import { connectedAccounts, connections } from "../schema.js";
import type { DrizzleDb, DrizzleTx } from "../index.js";

type Exec = DrizzleDb | DrizzleTx;

/** A link asked of a connection Rome no longer holds. */
export class ConnectedAccountNotFound extends Error {
  constructor(readonly connectionId: string) {
    super(`No connection with id "${connectionId}"`);
    this.name = "ConnectedAccountNotFound";
  }
}

/**
 * The connected accounts, each keyed by its connection's id and holding its
 * agent. A connected account lives as long as its connection: the database
 * removes it with the connection. Which connections take an agent is the
 * caller's rule, so `link` stores any agent it is given.
 */
export class ConnectedAccountsRepository {
  constructor(private readonly db: DrizzleDb) {}

  /** Make the connected account for `connectionId`, in `exec` (the
   *  transaction that mints the connection), with `agent` or none. A
   *  connected account that already exists keeps its agent. */
  add(exec: Exec, connectionId: string, agent: string | null = null): void {
    exec.insert(connectedAccounts).values({ connectionId, agent }).onConflictDoNothing().run();
  }

  /** The canonical id of the agent linked to `connectionId`'s account, or
   *  null when it has none or no connected account is recorded for it. */
  agentOf(connectionId: string): string | null {
    return (
      this.db
        .select({ agent: connectedAccounts.agent })
        .from(connectedAccounts)
        .where(eq(connectedAccounts.connectionId, connectionId))
        .get()?.agent ?? null
    );
  }

  /**
   * Link `agent` to `connectionId`'s account, or unlink it with null. Only
   * this account changes: an agent may be the agent of any number of
   * accounts. Main is stored by its canonical id. A connection Rome holds
   * with no record yet gets one. Throws {@link ConnectedAccountNotFound}
   * when Rome holds no such connection.
   */
  link(connectionId: string, requested: string | null): string | null {
    const agent = requested !== null && isCoreMainAgentId(requested) ? MAIN_AGENT_ID : requested;
    return this.db.transaction((tx) => {
      const held = tx
        .select({ id: connections.id })
        .from(connections)
        .where(eq(connections.id, connectionId))
        .get();
      if (!held) throw new ConnectedAccountNotFound(connectionId);
      tx.insert(connectedAccounts)
        .values({ connectionId, agent })
        .onConflictDoUpdate({ target: connectedAccounts.connectionId, set: { agent } })
        .run();
      return agent;
    });
  }

  /** Remove `connectionId`'s connected account, in `exec` (the transaction
   *  that ends the connection). */
  remove(exec: Exec, connectionId: string): void {
    exec.delete(connectedAccounts).where(eq(connectedAccounts.connectionId, connectionId)).run();
  }
}
