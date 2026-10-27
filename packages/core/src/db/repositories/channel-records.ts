import { randomUUID } from "node:crypto";
import type { Account } from "@rome-os/app-runtime";
import { and, asc, eq, isNotNull, isNull, ne, or } from "drizzle-orm";
import type { AccountLinkOf } from "../../channels/account-links.js";
import { platformOf } from "../../channels/platform.js";
import type { GrantAccount } from "../../connections/grant.js";
import { channels, connectionGrants } from "../schema.js";
import { inTransaction, type DrizzleDb, type DrizzleTx } from "../index.js";

/**
 * A channel a Connection backs, as stored: its id, the connection kind and platform
 * it is on, the platform's own id for the account (null until a grant reports
 * it), and the Connection behind it now. Its agent is its connected
 * account's (ConnectedAccountsRepository). The Connection behind it is the
 * one whose live grant reaches its platform and id, or, for a channel that
 * knows no account yet, the one it was claimed for; null when none is. Vocabulary: docs/domains/connections.md#connection.
 */
export interface ChannelRecord {
  id: string;
  connectionKind: string;
  platform: string;
  platformAccountId: string | null;
  connectionId: string | null;
  createdAt: Date;
}

type Exec = DrizzleDb | DrizzleTx;

/** Let go of the account `accountId` on `platform` from every channel but
 *  `keep`, so channel `keep` can record it. It runs only once the registry has
 *  refused an account another live grant reaches, so a channel that still holds
 *  the account is unbacked or backed by a Connection whose grant was given up.
 *  That Connection lets the channel go too: a channel that knows no account
 *  falls back to the Connection it was claimed for. */
function releaseAccount(exec: Exec, platform: string, accountId: string, keep: string): void {
  exec
    .update(channels)
    .set({ platformAccountId: null, connectionId: null })
    .where(
      and(
        eq(channels.platform, platform),
        eq(channels.platformAccountId, accountId),
        ne(channels.id, keep),
      ),
    )
    .run();
}

/** The connection kind a channel belongs to. A connection kind's first channel carries the
 *  connection kind's name, so a name with no record answers for itself. */
export type ConnectionKindOfChannel = (channel: string) => string;

/** The channels of Rome's accounts on a platform that a send may go out from.
 *  `ChannelRecordsRepository.sendersOn` states the rule. */
export type SendersOn = (platform: string) => string[] | null;

function toRecord(row: Omit<typeof channels.$inferSelect, "agent">): ChannelRecord {
  return {
    id: row.id,
    connectionKind: row.connectionKind,
    platform: row.platform,
    platformAccountId: row.platformAccountId,
    connectionId: row.connectionId,
    createdAt: row.createdAt,
  };
}

/** A channel row with the Connection whose live grant reaches its account. */
interface Reached {
  row: typeof channels.$inferSelect;
  custody: string | null;
}

/** The channel as a record, its Connection found by its account: the
 *  Connection whose live grant reaches it. A channel that knows no account yet
 *  falls back to the Connection it was claimed for. */
function reachedRecord({ row, custody }: Reached): ChannelRecord {
  return {
    ...toRecord(row),
    connectionId: row.platformAccountId === null ? row.connectionId : custody,
  };
}

/** Channels joined to the live grant that reaches each one's account. At most
 *  one does, by the grants' unique index. */
function reached(exec: Exec) {
  return exec
    .select({ row: channels, custody: connectionGrants.custody })
    .from(channels)
    .leftJoin(
      connectionGrants,
      and(
        eq(connectionGrants.platform, channels.platform),
        eq(connectionGrants.accountId, channels.platformAccountId),
        ne(connectionGrants.state, "unauthorized"),
      ),
    );
}

/**
 * The channels the Connections back.
 *
 * A channel's id is minted once and never changes, since every stored row
 * spells it. It is an opaque id, except that a connection kind's first channel carries
 * the connection kind's name, which is what data stored before channels were recorded
 * spells. A linkable connection kind's channel takes the name only when the boot pass
 * for those Connections asks for it. A row stays when its Connection goes, so its id is never minted
 * again. An account of a linkable connection kind starts fresh: the connection kind's next
 * Connection gets a channel of its own. Another connection kind's next Connection
 * takes the row back, since apps address that connection kind's one channel by its
 * name.
 */
export class ChannelRecordsRepository {
  /** Channel id by Connection id, read on every port use. Every write that
   *  moves a Connection empties it (a link moves none), and nothing is cached
   *  while a transaction is open, so a rolled-back write leaves no id behind. */
  private readonly ids = new Map<string, string | null>();
  /** `platformOfChannel` by channel, read for every row on every People
   *  read. It empties with `ids`, since only a write that moves a Connection
   *  changes a channel's platform. */
  private readonly platforms = new Map<string, string>();

  /** `linkOf` says which kinds of connection take an agent, whose accounts
   *  start fresh. */
  constructor(
    private readonly db: DrizzleDb,
    readonly linkOf: AccountLinkOf,
  ) {}

  all(): ChannelRecord[] {
    return reached(this.db).orderBy(asc(channels.createdAt)).all().map(reachedRecord);
  }

  byId(id: string): ChannelRecord | null {
    const found = reached(this.db).where(eq(channels.id, id)).get();
    return found ? reachedRecord(found) : null;
  }

  /** The connection kind behind channel `id`, or `id` itself when no channel
   *  records it: a connection kind's first channel's id is the connection kind's name. */
  connectionKindOf(id: string): string {
    return this.byId(id)?.connectionKind ?? id;
  }

  /** The platform channel `id` is an account on, or null when no channel
   *  records it. */
  platformOf(id: string): string | null {
    return this.byId(id)?.platform ?? null;
  }

  /**
   * The platform channel `name`'s accounts live on: its record's, or, for a
   * name no record holds, the platform of the connection kind it is named
   * after. A row stored before links named a platform names a channel, and
   * this is how it is read as an account.
   */
  platformOfChannel(name: string): string {
    const cached = this.platforms.get(name);
    if (cached !== undefined) return cached;
    const platform = this.platformOf(name) ?? platformOf(name);
    if (!inTransaction(this.db)) this.platforms.set(name, platform);
    return platform;
  }

  /**
   * The channels of Rome's accounts on `platform` a Connection backs, oldest
   * first: the ones a send to an account there may go out from. Rome never
   * picks among them. Null when no record is on the platform at all, which is
   * a platform only Rome's own channels serve, such as `webchat`: the
   * channels named after it answer then.
   */
  sendersOn(platform: string): string[] | null {
    const recorded = reached(this.db)
      .where(eq(channels.platform, platform))
      .orderBy(asc(channels.createdAt))
      .all()
      .map(reachedRecord);
    if (recorded.length === 0) return null;
    return recorded.filter((record) => record.connectionId !== null).map((record) => record.id);
  }

  /** Rome's own account on channel `id`, or null while its record knows none. */
  accountOf(id: string): Account | null {
    const record = this.byId(id);
    return record?.platformAccountId
      ? { platform: record.platform, id: record.platformAccountId }
      : null;
  }

  /** The id of the channel `connectionId` backs, or null for none. */
  idOf(connectionId: string): string | null {
    const cached = this.ids.get(connectionId);
    if (cached !== undefined) return cached;
    const id = this.byConnection(connectionId)?.id ?? null;
    if (!inTransaction(this.db)) this.ids.set(connectionId, id);
    return id;
  }

  /** The channel `connectionId` backs: the one whose account its live grant
   *  reaches, or the one claimed for it that knows no account yet. */
  byConnection(connectionId: string): ChannelRecord | null {
    const found = reached(this.db)
      .where(
        or(
          eq(connectionGrants.custody, connectionId),
          and(isNull(channels.platformAccountId), eq(channels.connectionId, connectionId)),
        ),
      )
      .get();
    return found ? reachedRecord(found) : null;
  }

  /** Forget what the caches hold, after a grant is given up: the channel its
   *  Connection backed is backed by none now. */
  forget(): void {
    this.ids.clear();
    this.platforms.clear();
  }

  /**
   * The channel `connection` backs, recorded in `exec` (the transaction that
   * mints the Connection). A Connection that already has one keeps it. A
   * Connection of a linkable connection kind never takes over another account's
   * channel, so it starts with no history. A Connection of any other connection kind
   * takes back the connection kind's unbacked channel, the one carrying the connection kind's
   * name first. Failing that, it gets the connection kind's name if no channel holds
   * it, and a fresh opaque id otherwise. A linkable connection kind's channel gets an
   * opaque id, so its id is one no account ever had, unless the caller names
   * one (`id`, taken only while free). `domain` is a Feishu app's domain,
   * which decides its channel's platform. `account` is the account the Connection reaches, when
   * its grant reports one, and the channel records it; its platform decides
   * the channel's. Which channel is taken back does not depend on it yet:
   * names such as `email` and `whatsapp` still reach a connection kind's one
   * channel.
   */
  claim(
    exec: Exec,
    connection: { id: string; connectionKind: string; domain?: string; account?: GrantAccount },
    now: Date,
    { id: named }: { id?: string } = {},
  ): ChannelRecord {
    const held = exec.select().from(channels).where(eq(channels.connectionId, connection.id)).get();
    if (held) return toRecord(held);
    this.ids.clear();
    this.platforms.clear();

    const connectionKind = connection.connectionKind;
    const platform = connection.account?.platform ?? platformOf(connectionKind, connection.domain);
    const accountId = connection.account?.accountId ?? null;
    const vacant =
      this.linkOf(connectionKind) !== null
        ? undefined
        : exec
            .select()
            .from(channels)
            .where(and(eq(channels.connectionKind, connectionKind), isNull(channels.connectionId)))
            .all()
            .sort(
              (a, b) =>
                Number(b.id === connectionKind) - Number(a.id === connectionKind) ||
                a.createdAt.getTime() - b.createdAt.getTime(),
            )[0];
    if (vacant) {
      if (accountId !== null) releaseAccount(exec, platform, accountId, vacant.id);
      // A different account taking the channel back replaces the one it held.
      const taken = {
        connectionId: connection.id,
        platformAccountId: accountId,
        platform: accountId === null ? vacant.platform : platform,
      };
      exec.update(channels).set(taken).where(eq(channels.id, vacant.id)).run();
      return toRecord({ ...vacant, ...taken });
    }

    const wanted = named ?? (this.linkOf(connectionKind) !== null ? undefined : connectionKind);
    const free =
      wanted !== undefined &&
      exec.select({ id: channels.id }).from(channels).where(eq(channels.id, wanted)).get() ===
        undefined;
    const id = free ? wanted : randomUUID();
    if (accountId !== null) releaseAccount(exec, platform, accountId, id);
    const row = {
      id,
      connectionKind,
      platform,
      platformAccountId: accountId,
      connectionId: connection.id,
      createdAt: now,
    };
    exec.insert(channels).values(row).run();
    return toRecord(row);
  }

  /**
   * Record that the channel `connectionId` backs is `account`, once a grant
   * reports it: the account's platform and the platform's own id for it. A
   * Connection kept across a revoke may be given access to another account,
   * which then replaces the one its channel held, platform included (a Feishu
   * app given access again on Lark).
   */
  recordAccount(exec: Exec, connectionId: string, account: GrantAccount): void {
    const { platform, accountId } = account;
    // A grant given again reaches its account again, whichever it is, so what
    // the caches hold from while it was given up goes.
    this.ids.clear();
    this.platforms.clear();
    const row = exec.select().from(channels).where(eq(channels.connectionId, connectionId)).get();
    if (!row || (row.platform === platform && row.platformAccountId === accountId)) return;
    releaseAccount(exec, platform, accountId, row.id);
    exec
      .update(channels)
      .set({ platform, platformAccountId: accountId })
      .where(eq(channels.id, row.id))
      .run();
  }

  /**
   * Record `account` on the channel `connection` backs, or claim one for it
   * when it backs none: a Connection kept across a revoke whose account went
   * to another Connection let its channel go, and a grant given to it again
   * needs one to talk through.
   */
  ensureAccount(
    exec: Exec,
    connection: { id: string; connectionKind: string },
    account: GrantAccount,
    now: Date,
  ): void {
    const held = exec
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.connectionId, connection.id))
      .get();
    if (held) this.recordAccount(exec, connection.id, account);
    else this.claim(exec, { ...connection, account }, now);
  }

  /** Release the channel `connectionId` backs. The row and its id stay. A
   *  channel of a connection kind that takes an agent also lets go of its
   *  account, so connecting that account again makes a fresh record
   *  (docs/domains/connections.md#connection). */
  vacate(exec: Exec, connectionId: string): void {
    this.ids.clear();
    this.platforms.clear();
    const row = exec.select().from(channels).where(eq(channels.connectionId, connectionId)).get();
    if (!row) return;
    exec
      .update(channels)
      .set({
        connectionId: null,
        platformAccountId: this.linkOf(row.connectionKind) !== null ? null : row.platformAccountId,
      })
      .where(eq(channels.id, row.id))
      .run();
  }

  /** The Connections no channel records yet, for the boot pass that gives
   *  each a channel. */
  unclaimed(connections: ReadonlyArray<{ id: string; connectionKind: string }>): Array<{
    id: string;
    connectionKind: string;
  }> {
    const claimed = new Set(
      this.db
        .select({ connectionId: channels.connectionId })
        .from(channels)
        .where(isNotNull(channels.connectionId))
        .all()
        .map((row) => row.connectionId),
    );
    return connections.filter((connection) => !claimed.has(connection.id));
  }
}
