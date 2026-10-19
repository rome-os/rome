import { randomUUID } from "node:crypto";
import { LINKABLE_SERVICES, MAIN_AGENT_ID } from "@rome/api-types/linked-agents";
import { and, asc, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { isCoreMainAgentId } from "../../apps/artifact-id.js";
import { platformOf } from "../../channels/platform.js";
import { channels } from "../schema.js";
import { inTransaction, type DrizzleDb, type DrizzleTx } from "../index.js";

/**
 * A channel a Connection backs, as stored: its id, the service and platform
 * it is on, the Connection behind it now (null once that Connection is gone),
 * and the agent linked to it. Vocabulary: docs/concepts/messaging.md#channels.
 */
export interface ChannelRecord {
  id: string;
  service: string;
  platform: string;
  connectionId: string | null;
  agent: string | null;
  createdAt: Date;
}

/** What a link changed: the channel as it now stands, and the channel on the
 *  same platform the agent was taken from, if it was linked to one. */
export interface LinkOutcome {
  channel: ChannelRecord;
  unlinkedFrom: string | null;
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

/** A link asked of a channel whose service takes no linked agent. */
export class ChannelNotLinkable extends Error {
  constructor(
    readonly channel: string,
    readonly service: string,
  ) {
    super(`A ${service} account cannot be linked to an agent`);
    this.name = "ChannelNotLinkable";
  }
}

type Exec = DrizzleDb | DrizzleTx;

/** The agent a newly backed channel starts linked to: main on a linkable
 *  service's first account, the one carrying the service's name. */
function firstAccountAgent(id: string, service: string): string | null {
  return id === service && LINKABLE_SERVICES.has(service) ? MAIN_AGENT_ID : null;
}

/** The service a channel belongs to. A service's first channel carries the
 *  service's name, so a name with no record answers for itself. */
export type ServiceOfChannel = (channel: string) => string;

function toRecord(row: typeof channels.$inferSelect): ChannelRecord {
  return {
    id: row.id,
    service: row.service,
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
 * spells it. It is an opaque id, except that a service's first channel carries
 * the service's name, which is what data stored before channels were recorded
 * spells. A row stays when its Connection goes, and the service's next
 * Connection takes it back before a new id is minted.
 */
export class ChannelRecordsRepository {
  /** Channel id by Connection id, read on every port use. Every write that
   *  moves a Connection empties it (a link moves none), and nothing is cached
   *  while a transaction is open, so a rolled-back write leaves no id behind. */
  private readonly ids = new Map<string, string | null>();

  constructor(private readonly db: DrizzleDb) {}

  all(): ChannelRecord[] {
    return this.db.select().from(channels).orderBy(asc(channels.createdAt)).all().map(toRecord);
  }

  byId(id: string): ChannelRecord | null {
    const row = this.db.select().from(channels).where(eq(channels.id, id)).get();
    return row ? toRecord(row) : null;
  }

  /** The service behind channel `id`, or `id` itself when no channel
   *  records it: a service's first channel's id is the service's name. */
  serviceOf(id: string): string {
    return this.byId(id)?.service ?? id;
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
   * mints the Connection). A Connection that already has one keeps it. Else
   * it takes back the service's unbacked channel, the one carrying the
   * service's name first, so a deleted and re-added bot keeps its channel.
   * Failing that, it gets the service's name if no channel holds it, and a
   * fresh opaque id otherwise. A channel it gets that carries the service's
   * name, the service's first account, is linked to main when the service is
   * linkable, so a guardian's first bot answers. A later account starts
   * unlinked.
   */
  claim(exec: Exec, connection: { id: string; service: string }, now: Date): ChannelRecord {
    const held = exec.select().from(channels).where(eq(channels.connectionId, connection.id)).get();
    if (held) return toRecord(held);
    this.ids.clear();

    const service = connection.service;
    const vacant = exec
      .select()
      .from(channels)
      .where(and(eq(channels.service, service), isNull(channels.connectionId)))
      .all()
      .sort(
        (a, b) =>
          Number(b.id === service) - Number(a.id === service) ||
          a.createdAt.getTime() - b.createdAt.getTime(),
      )[0];
    if (vacant) {
      const agent = firstAccountAgent(vacant.id, service);
      exec
        .update(channels)
        .set({ connectionId: connection.id, agent })
        .where(eq(channels.id, vacant.id))
        .run();
      return toRecord({ ...vacant, connectionId: connection.id, agent });
    }

    const serviceIdTaken =
      exec.select({ id: channels.id }).from(channels).where(eq(channels.id, service)).get() !==
      undefined;
    const id = serviceIdTaken ? randomUUID() : service;
    const row = {
      id,
      service,
      platform: platformOf(service),
      connectionId: connection.id,
      agent: firstAccountAgent(id, service),
      createdAt: now,
    };
    exec.insert(channels).values(row).run();
    return toRecord(row);
  }

  /** Release the channel `connectionId` backs. The row and its id stay, and
   *  its link goes: an agent stays linked only where it can still answer. */
  vacate(exec: Exec, connectionId: string): void {
    this.ids.clear();
    exec
      .update(channels)
      .set({ connectionId: null, agent: null })
      .where(eq(channels.connectionId, connectionId))
      .run();
  }

  /**
   * Link `agent` to channel `id`, or unlink it with null. On one platform an
   * agent other than main is linked to at most one channel, so linking it here
   * unlinks it from any other channel on this platform, in the same
   * transaction. The partial unique index rejects any write that would break
   * the rule anyway. Main may hold several channels of one platform, and is
   * stored by its canonical id. Only a channel of a linkable service takes a
   * link; unlinking is always open.
   */
  link(id: string, requested: string | null): LinkOutcome {
    const agent = requested !== null && isCoreMainAgentId(requested) ? MAIN_AGENT_ID : requested;
    return this.db.transaction((tx) => {
      const row = tx.select().from(channels).where(eq(channels.id, id)).get();
      if (!row) throw new ChannelRecordNotFound(id);
      if (agent !== null && !LINKABLE_SERVICES.has(row.service)) {
        throw new ChannelNotLinkable(id, row.service);
      }
      if (agent !== null && row.connectionId === null) throw new ChannelUnbacked(id);
      let unlinkedFrom: string | null = null;
      if (agent !== null && agent !== MAIN_AGENT_ID) {
        const holder = tx
          .select({ id: channels.id })
          .from(channels)
          .where(
            and(
              eq(channels.platform, row.platform),
              eq(channels.agent, agent),
              ne(channels.id, id),
            ),
          )
          .get();
        if (holder) {
          tx.update(channels).set({ agent: null }).where(eq(channels.id, holder.id)).run();
          unlinkedFrom = holder.id;
        }
      }
      tx.update(channels).set({ agent }).where(eq(channels.id, id)).run();
      return { channel: toRecord({ ...row, agent }), unlinkedFrom };
    });
  }

  /** The Connections no channel records yet, for the boot pass that gives
   *  each a channel. */
  unclaimed(connections: ReadonlyArray<{ id: string; service: string }>): Array<{
    id: string;
    service: string;
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
