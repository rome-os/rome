// Chats' record of each connected account and the agent that speaks through
// it. Vocabulary: docs/domains/chats.md#connected-account.

import { MAIN_AGENT_ID } from "@rome/api-types/account-agents";
import { and, eq, isNotNull, type SQL } from "drizzle-orm";
import { createLogger } from "../../logger.js";
import { isCoreMainAgentId } from "../../apps/artifact-id.js";
import {
  accountProfiles,
  channels,
  connectedAccounts,
  connectedAccountsUnplaced,
  connectionGrants,
  connections,
} from "../schema.js";
import type { DrizzleDb, DrizzleTx } from "../index.js";

type Exec = DrizzleDb | DrizzleTx;

const log = createLogger("connected-accounts");

/** An account, by its platform and the platform's own id. */
export interface AccountKey {
  platform: string;
  accountId: string;
}

/** One connected account as the dashboard lists it. */
export interface ConnectedAccountRow extends AccountKey {
  /** Canonical id of the account's agent, or null for none. */
  agent: string | null;
  /** The connection that reaches the account, or null while it is
   *  disconnected. */
  connectionId: string | null;
  /** The name the account's platform last gave it, when Rome has learned
   *  one. */
  name: string | null;
}

/** A link asked of a connection Rome no longer holds, or of one whose grant
 *  has not reported its account yet. */
export class ConnectedAccountNotFound extends Error {
  constructor(readonly connectionId: string) {
    super(`No connection with id "${connectionId}" that reaches an account`);
    this.name = "ConnectedAccountNotFound";
  }
}

/**
 * The connected accounts, each keyed by its account (the platform and the
 * platform's own id) and holding its agent. Callers name a connected account
 * by the connection that reaches it, and the account is read from that
 * connection's grant, else, for a grant that names none (a revoked one), from
 * the account its channel record was claimed for. A connection that reaches
 * no account that way has no connected account. Which connections take an
 * agent is the caller's rule, so `link` stores any agent it is given. A
 * connected account outlives the connection that reached it: disconnecting
 * leaves it, agent kept, and connecting the same account again finds it.
 */
export class ConnectedAccountsRepository {
  constructor(private readonly db: DrizzleDb) {}

  /** The account `connectionId` reaches, as `exec` sees it: the one its
   *  grant names, else the one its channel record was claimed for. Null when
   *  neither names one. */
  accountOf(exec: Exec, connectionId: string): AccountKey | null {
    const granted = exec
      .select({ platform: connectionGrants.platform, accountId: connectionGrants.accountId })
      .from(connectionGrants)
      .innerJoin(connections, eq(connections.id, connectionGrants.custody))
      .where(
        and(
          eq(connectionGrants.custody, connectionId),
          isNotNull(connectionGrants.platform),
          isNotNull(connectionGrants.accountId),
        ),
      )
      .get();
    if (granted?.platform && granted.accountId) {
      return { platform: granted.platform, accountId: granted.accountId };
    }
    const claimed = exec
      .select({ platform: channels.platform, accountId: channels.platformAccountId })
      .from(channels)
      .where(and(eq(channels.connectionId, connectionId), isNotNull(channels.platformAccountId)))
      .get();
    return claimed?.accountId ? { platform: claimed.platform, accountId: claimed.accountId } : null;
  }

  /** Make the connected account for the account `connectionId` reaches, in
   *  `exec` (the transaction that connects it), with `agent` or none. A
   *  connected account that already exists keeps its agent, and a connection
   *  that reaches no account yet makes none. A link the move to account keys
   *  left unplaced for this connection is placed now, and wins over `agent`. */
  add(exec: Exec, connectionId: string, agent: string | null = null): void {
    const account = this.accountOf(exec, connectionId);
    if (!account) return;
    const unplaced = exec
      .select({ agent: connectedAccountsUnplaced.agent })
      .from(connectedAccountsUnplaced)
      .where(eq(connectedAccountsUnplaced.connectionId, connectionId))
      .get();
    exec
      .insert(connectedAccounts)
      .values({ ...account, agent: unplaced?.agent ?? agent })
      .onConflictDoNothing()
      .run();
    if (unplaced) this.forgetUnplaced(exec, connectionId);
  }

  /**
   * Place each link the move to account keys left unplaced, once the boot pass
   * has recorded grants' accounts. A link whose connection now reaches an
   * account goes to that account, unless the account already has a connected
   * account. A link whose connection is gone goes, logged. One whose
   * connection still reaches no account waits for {@link add}.
   */
  placeUnplaced(): void {
    const rows = this.db.select().from(connectedAccountsUnplaced).all();
    for (const { connectionId, agent } of rows) {
      this.db.transaction((tx) => {
        if (this.accountOf(tx, connectionId)) {
          this.add(tx, connectionId);
          return;
        }
        const held = tx
          .select({ id: connections.id })
          .from(connections)
          .where(eq(connections.id, connectionId))
          .get();
        if (held) return;
        log.warn("dropped an agent link whose connection is gone", { connectionId, agent });
        this.forgetUnplaced(tx, connectionId);
      });
    }
  }

  /** Drop the unplaced link of `connectionId`, if any, in `exec`. */
  forgetUnplaced(exec: Exec, connectionId: string): void {
    exec
      .delete(connectedAccountsUnplaced)
      .where(eq(connectedAccountsUnplaced.connectionId, connectionId))
      .run();
  }

  /** The canonical id of the agent linked to the account `connectionId`
   *  reaches, or null when it has none or the connection reaches none. */
  agentOf(connectionId: string): string | null {
    const account = this.accountOf(this.db, connectionId);
    if (!account) return null;
    return (
      this.db
        .select({ agent: connectedAccounts.agent })
        .from(connectedAccounts)
        .where(
          and(
            eq(connectedAccounts.platform, account.platform),
            eq(connectedAccounts.accountId, account.accountId),
          ),
        )
        .get()?.agent ?? null
    );
  }

  /**
   * Link `agent` to the account `connectionId` reaches, or unlink it with
   * null. Only this account changes: an agent may be the agent of any number
   * of accounts. Main is stored by its canonical id. An account with no record
   * yet gets one. Throws {@link ConnectedAccountNotFound} when Rome holds no
   * such connection, or its grant has not reported its account.
   */
  link(connectionId: string, requested: string | null): string | null {
    const agent = requested !== null && isCoreMainAgentId(requested) ? MAIN_AGENT_ID : requested;
    return this.db.transaction((tx) => {
      const account = this.accountOf(tx, connectionId);
      if (!account) throw new ConnectedAccountNotFound(connectionId);
      tx.insert(connectedAccounts)
        .values({ ...account, agent })
        .onConflictDoUpdate({
          target: [connectedAccounts.platform, connectedAccounts.accountId],
          set: { agent },
        })
        .run();
      // The guardian's own link supersedes one the move left unplaced.
      this.forgetUnplaced(tx, connectionId);
      return agent;
    });
  }

  /** Every connected account with its agent, and the connection that
   *  reaches it, or null for one that is disconnected. */
  all(): ConnectedAccountRow[] {
    return this.rows();
  }

  /** The connected account for `account`, or null when Rome has none. */
  get(account: AccountKey): ConnectedAccountRow | null {
    return (
      this.rows(
        and(
          eq(connectedAccounts.platform, account.platform),
          eq(connectedAccounts.accountId, account.accountId),
        ),
      )[0] ?? null
    );
  }

  private rows(where?: SQL): ConnectedAccountRow[] {
    const accounts = this.db
      .select({
        platform: connectedAccounts.platform,
        accountId: connectedAccounts.accountId,
        agent: connectedAccounts.agent,
        displayName: accountProfiles.displayName,
        handle: accountProfiles.handle,
      })
      .from(connectedAccounts)
      .leftJoin(
        accountProfiles,
        and(
          eq(accountProfiles.platform, connectedAccounts.platform),
          eq(accountProfiles.accountId, connectedAccounts.accountId),
        ),
      )
      .where(where)
      .orderBy(connectedAccounts.platform, connectedAccounts.accountId)
      .all();
    return accounts.map(({ displayName, handle, ...account }) => ({
      ...account,
      connectionId: this.connectionTo(account),
      name: displayName || handle || null,
    }));
  }

  /** The connection that reaches `account`, or null when none does. */
  connectionTo(account: AccountKey): string | null {
    return (
      this.db
        .select({ id: connections.id })
        .from(connectionGrants)
        .innerJoin(connections, eq(connections.id, connectionGrants.custody))
        .where(
          and(
            eq(connectionGrants.platform, account.platform),
            eq(connectionGrants.accountId, account.accountId),
          ),
        )
        .get()?.id ?? null
    );
  }

  /** Unlink the agent of `account`, connected or not. Returns false when Rome
   *  has no connected account for it. */
  unlink(account: AccountKey): boolean {
    const result = this.db
      .update(connectedAccounts)
      .set({ agent: null })
      .where(
        and(
          eq(connectedAccounts.platform, account.platform),
          eq(connectedAccounts.accountId, account.accountId),
        ),
      )
      .run();
    return result.changes > 0;
  }
}
