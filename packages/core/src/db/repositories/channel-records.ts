import { randomUUID } from "node:crypto";
import { LINKABLE_KINDS, MAIN_AGENT_ID } from "@rome/api-types/account-agents";
import { and, asc, eq, isNotNull, isNull, ne, or } from "drizzle-orm";
import { isCoreMainAgentId } from "../../apps/artifact-id.js";
import { platformOf } from "../../channels/platform.js";
import type { GrantAccount } from "../../connections/ledger.js";
import { channels, connectionGrants } from "../schema.js";
import { inTransaction, type DrizzleDb, type DrizzleTx } from "../index.js";

/**
 * A channel a Connection backs, as stored: its id, the connection kind and platform
 * it is on, the platform's own id for the account (null until a grant reports
 * it), the Connection behind it now, and the agent linked to it. The
 * Connection behind it is the one whose live grant reaches its platform and
 * id, or, for a channel that knows no account yet, the one it was claimed
 * for; null when none is. Vocabulary: docs/domains/connections.md#connection.
 */
export interface ChannelRecord {
  id: string;
  connectionKind: string;
  platform: string;
  platformAccountId: string | null;
  connectionId: string | null;
  agent: string | null;
  createdAt: Date;
}

export class ChannelRecordNotFound extends Error {
  constructor(readonly channel: string) {
    super(`No channel with id "${channel}"`);
    this.name = "ChannelRecordNotFound";
  }
}

/** A link asked of a channel no Connection backs now. */
export class ChannelUnbacked extends Error {
  constructor(readonly channel: string) {
    super(`Channel "${channel}" has no connection, so no agent can be linked to it`);
    this.name = "ChannelUnbacked";
  }
}

/** A link asked of a channel whose connection kind takes no agent. */
export class ChannelNotLinkable extends Error {
  constructor(
    readonly channel: string,
    readonly connectionKind: string,
  ) {
    super(`A ${connectionKind} account cannot be linked to an agent`);
    this.name = "ChannelNotLinkable";
  }
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
    .set({ platformAccountId: null, connectionId: null, agent: null })
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

/** The one channel a person's link reaches, or null when it reaches none.
 *  `ChannelRecordsRepository.channelOfLink` states the rule. */
export type ChannelOfLink = (link: string) => string | null;

/** The ids of Rome's accounts a send to a person's link may go out from.
 *  `ChannelRecordsRepository.sendersOfLink` states the rule. */
export type SendersOfLink = (link: string) => string[];

function toRecord(row: typeof channels.$inferSelect): ChannelRecord {
  return {
    id: row.id,
    connectionKind: row.connectionKind,
    platform: row.platform,
    platformAccountId: row.platformAccountId,
    connectionId: row.connectionId,
    agent: row.agent,
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
 * The channels the Connections back, and which agent each is linked to.
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
  /** `channelOfLink` by link, read for every link on every People read. It
   *  empties with `ids`, since only a write that moves a Connection changes
   *  which channels are backed. */
  private readonly links = new Map<string, string | null>();

  constructor(private readonly db: DrizzleDb) {}

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
   * The channel a person's link keyed by `link` reaches. People keys a link by
   * connection kind, and Rome never picks among a connection kind's accounts, so:
   *
   * - A link naming a channel whose connection kind is another name (an opaque id)
   *   reaches that channel.
   * - A link naming a connection kind reaches the connection kind's one account: the one
   *   channel of it a Connection backs. With none backed it reaches the
   *   channel carrying the connection kind's name, as for a connection kind no record names.
   * - With several backed, it reaches none, so null.
   *
   * Backed channels are counted rather than recorded ones, since a released
   * row stays after its account is removed and is not an account.
   */
  channelOfLink(link: string): string | null {
    const cached = this.links.get(link);
    if (cached !== undefined) return cached;
    const senders = this.sendersOfLink(link);
    const reached =
      senders.length === 0 ? link : senders.length === 1 ? (senders[0] ?? null) : null;
    if (!inTransaction(this.db)) this.links.set(link, reached);
    return reached;
  }

  /**
   * The ids of Rome's accounts a send to a person's link keyed by `link` may
   * name to go out from, oldest first. A link naming a channel's own opaque id
   * answers that channel while a Connection backs it. A link naming a connection kind
   * answers each channel of the connection kind a Connection backs, or the channel
   * carrying the connection kind's name when none is, as for a connection kind no record names.
   */
  sendersOfLink(link: string): string[] {
    const own = this.byId(link);
    if (own && own.connectionKind !== link) return own.connectionId === null ? [] : [link];
    const backed = reached(this.db)
      .where(eq(channels.connectionKind, link))
      .orderBy(asc(channels.createdAt))
      .all()
      .map(reachedRecord)
      .filter((record) => record.connectionId !== null);
    return backed.length === 0 ? [link] : backed.map((record) => record.id);
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
    this.links.clear();
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
   * one (`id`, taken only while free). A new channel is linked to `agent`
   * when its connection kind takes one, and to none by default: Rome picks no agent
   * for an account. `domain` is a Feishu app's domain, which decides its
   * channel's platform. `account` is the account the Connection reaches, when
   * its grant reports one, and the channel records it; its platform decides
   * the channel's. Which channel is taken back does not depend on it yet:
   * names such as `email` and `whatsapp` still reach a connection kind's one
   * channel.
   */
  claim(
    exec: Exec,
    connection: { id: string; connectionKind: string; domain?: string; account?: GrantAccount },
    now: Date,
    { agent = null, id: named }: { agent?: string | null; id?: string } = {},
  ): ChannelRecord {
    const held = exec.select().from(channels).where(eq(channels.connectionId, connection.id)).get();
    if (held) return toRecord(held);
    this.ids.clear();
    this.links.clear();

    const connectionKind = connection.connectionKind;
    const platform = connection.account?.platform ?? platformOf(connectionKind, connection.domain);
    const accountId = connection.account?.accountId ?? null;
    const vacant = LINKABLE_KINDS.has(connectionKind)
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
      // Only a connection kind that takes no agent gets here, so the channel starts with none.
      if (accountId !== null) releaseAccount(exec, platform, accountId, vacant.id);
      // A different account taking the channel back replaces the one it held.
      const taken = {
        connectionId: connection.id,
        agent: null,
        platformAccountId: accountId,
        platform: accountId === null ? vacant.platform : platform,
      };
      exec.update(channels).set(taken).where(eq(channels.id, vacant.id)).run();
      return toRecord({ ...vacant, ...taken });
    }

    const wanted = named ?? (LINKABLE_KINDS.has(connectionKind) ? undefined : connectionKind);
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
      agent: LINKABLE_KINDS.has(connectionKind) ? agent : null,
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
    this.links.clear();
    const row = exec.select().from(channels).where(eq(channels.connectionId, connectionId)).get();
    if (!row || (row.platform === platform && row.platformAccountId === accountId)) return;
    releaseAccount(exec, platform, accountId, row.id);
    exec
      .update(channels)
      .set({ platform, platformAccountId: accountId })
      .where(eq(channels.id, row.id))
      .run();
  }

  /** Release the channel `connectionId` backs. The row and its id stay, and
   *  its link goes: an agent stays linked only where it can still answer. A
   *  channel of a connection kind that takes an agent also lets go of its
   *  account, so connecting that account again makes a fresh record
   *  (docs/domains/connections.md#connection). */
  vacate(exec: Exec, connectionId: string): void {
    this.ids.clear();
    this.links.clear();
    const row = exec.select().from(channels).where(eq(channels.connectionId, connectionId)).get();
    if (!row) return;
    exec
      .update(channels)
      .set({
        connectionId: null,
        agent: null,
        platformAccountId: LINKABLE_KINDS.has(row.connectionKind) ? null : row.platformAccountId,
      })
      .where(eq(channels.id, row.id))
      .run();
  }

  /**
   * Link `agent` to channel `id`, or unlink it with null, and return the
   * channel as it now stands. Only channel `id` changes: an agent may be the
   * agent of any number of channels, several on one platform included. Main is
   * stored by its canonical id. Only a channel of a linkable connection kind takes a
   * link; unlinking is always open.
   */
  link(id: string, requested: string | null): ChannelRecord {
    const agent = requested !== null && isCoreMainAgentId(requested) ? MAIN_AGENT_ID : requested;
    return this.db.transaction((tx) => {
      const found = reached(tx).where(eq(channels.id, id)).get();
      if (!found) throw new ChannelRecordNotFound(id);
      const row = reachedRecord(found);
      if (agent !== null && !LINKABLE_KINDS.has(row.connectionKind)) {
        throw new ChannelNotLinkable(id, row.connectionKind);
      }
      if (agent !== null && row.connectionId === null) throw new ChannelUnbacked(id);
      tx.update(channels).set({ agent }).where(eq(channels.id, id)).run();
      return { ...row, agent };
    });
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
