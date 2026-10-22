import { randomUUID } from "node:crypto";
import { LINKABLE_KINDS, MAIN_AGENT_ID } from "@rome/api-types/account-agents";
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { isCoreMainAgentId } from "../../apps/artifact-id.js";
import { platformOf } from "../../channels/platform.js";
import { channels } from "../schema.js";
import { inTransaction, type DrizzleDb, type DrizzleTx } from "../index.js";

/**
 * A channel a Connection backs, as stored: its id, the connection kind and platform
 * it is on, the Connection behind it now (null once that Connection is gone),
 * and the agent linked to it. Vocabulary: docs/domains/chats.md#account.
 */
export interface ChannelRecord {
  id: string;
  connectionKind: string;
  platform: string;
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
    connectionId: row.connectionId,
    agent: row.agent,
    createdAt: row.createdAt,
  };
}

/**
 * The channels the Connections back, and which agent each is linked to.
 *
 * A channel's id is minted once and never changes, since every stored row
 * spells it. It is an opaque id, except that a connection kind's first channel carries
 * the connection kind's name, which is what data stored before channels were recorded
 * spells. A row stays when its Connection goes, so its id is never minted
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
    return this.db.select().from(channels).orderBy(asc(channels.createdAt)).all().map(toRecord);
  }

  byId(id: string): ChannelRecord | null {
    const row = this.db.select().from(channels).where(eq(channels.id, id)).get();
    return row ? toRecord(row) : null;
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
    const backed = this.db
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.connectionKind, link), isNotNull(channels.connectionId)))
      .orderBy(asc(channels.createdAt))
      .all();
    return backed.length === 0 ? [link] : backed.map((row) => row.id);
  }

  /** The id of the channel `connectionId` backs, or null for none. */
  idOf(connectionId: string): string | null {
    const cached = this.ids.get(connectionId);
    if (cached !== undefined) return cached;
    const id = this.byConnection(connectionId)?.id ?? null;
    if (!inTransaction(this.db)) this.ids.set(connectionId, id);
    return id;
  }

  byConnection(connectionId: string): ChannelRecord | null {
    const row = this.db
      .select()
      .from(channels)
      .where(eq(channels.connectionId, connectionId))
      .get();
    return row ? toRecord(row) : null;
  }

  /**
   * The channel `connection` backs, recorded in `exec` (the transaction that
   * mints the Connection). A Connection that already has one keeps it. A
   * Connection of a linkable connection kind never takes over another account's
   * channel, so it starts with no history. A Connection of any other connection kind
   * takes back the connection kind's unbacked channel, the one carrying the connection kind's
   * name first. Failing that, it gets the connection kind's name if no channel holds
   * it, and a fresh opaque id otherwise. A new channel is linked to `agent`
   * when its connection kind takes one, and to none by default: Rome picks no agent
   * for an account. `domain` is a Feishu app's domain, which decides its
   * channel's platform.
   */
  claim(
    exec: Exec,
    connection: { id: string; connectionKind: string; domain?: string },
    now: Date,
    { agent = null }: { agent?: string | null } = {},
  ): ChannelRecord {
    const held = exec.select().from(channels).where(eq(channels.connectionId, connection.id)).get();
    if (held) return toRecord(held);
    this.ids.clear();
    this.links.clear();

    const connectionKind = connection.connectionKind;
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
      exec
        .update(channels)
        .set({ connectionId: connection.id, agent: null })
        .where(eq(channels.id, vacant.id))
        .run();
      return toRecord({ ...vacant, connectionId: connection.id, agent: null });
    }

    const kindIdTaken =
      exec
        .select({ id: channels.id })
        .from(channels)
        .where(eq(channels.id, connectionKind))
        .get() !== undefined;
    const id = kindIdTaken ? randomUUID() : connectionKind;
    const row = {
      id,
      connectionKind,
      platform: platformOf(connectionKind, connection.domain),
      connectionId: connection.id,
      agent: LINKABLE_KINDS.has(connectionKind) ? agent : null,
      createdAt: now,
    };
    exec.insert(channels).values(row).run();
    return toRecord(row);
  }

  /** Release the channel `connectionId` backs. The row and its id stay, and
   *  its link goes: an agent stays linked only where it can still answer. */
  vacate(exec: Exec, connectionId: string): void {
    this.ids.clear();
    this.links.clear();
    exec
      .update(channels)
      .set({ connectionId: null, agent: null })
      .where(eq(channels.connectionId, connectionId))
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
      const row = tx.select().from(channels).where(eq(channels.id, id)).get();
      if (!row) throw new ChannelRecordNotFound(id);
      if (agent !== null && !LINKABLE_KINDS.has(row.connectionKind)) {
        throw new ChannelNotLinkable(id, row.connectionKind);
      }
      if (agent !== null && row.connectionId === null) throw new ChannelUnbacked(id);
      tx.update(channels).set({ agent }).where(eq(channels.id, id)).run();
      return toRecord({ ...row, agent });
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
