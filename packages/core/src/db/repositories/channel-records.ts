import { randomUUID } from "node:crypto";
import { LINKABLE_SERVICES, MAIN_AGENT_ID } from "@rome/api-types/account-agents";
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { isCoreMainAgentId } from "../../apps/artifact-id.js";
import { platformOf } from "../../channels/platform.js";
import { channels } from "../schema.js";
import { inTransaction, type DrizzleDb, type DrizzleTx } from "../index.js";

/**
 * A channel a Connection backs, as stored: its id, the service and platform
 * it is on, the Connection behind it now (null once that Connection is gone),
 * and the agent linked to it. Vocabulary: docs/concepts/messaging.md#romes-accounts.
 */
export interface ChannelRecord {
  id: string;
  service: string;
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

/** A link asked of a channel whose service takes no agent. */
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
 * spells. A linkable service's channel takes the name only when the boot pass
 * for those Connections asks for it. A row stays when its Connection goes, so its id is never minted
 * again. An account of a linkable service starts fresh: the service's next
 * Connection gets a channel of its own. Another service's next Connection
 * takes the row back, since apps address that service's one channel by its
 * name.
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
   * mints the Connection). A Connection that already has one keeps it. A
   * Connection of a linkable service never takes over another account's
   * channel, so it starts with no history. A Connection of any other service
   * takes back the service's unbacked channel, the one carrying the service's
   * name first. Failing that, it gets the service's name if no channel holds
   * it, and a fresh opaque id otherwise. A linkable service's channel gets an
   * opaque id, so its id is one no account ever had, unless the caller names
   * one (`id`, taken only while free). A new channel is linked to `agent`
   * when its service takes one, and to none by default: Rome picks no agent
   * for an account. `domain` is a Feishu app's domain, which decides its
   * channel's platform.
   */
  claim(
    exec: Exec,
    connection: { id: string; service: string; domain?: string },
    now: Date,
    { agent = null, id: named }: { agent?: string | null; id?: string } = {},
  ): ChannelRecord {
    const held = exec.select().from(channels).where(eq(channels.connectionId, connection.id)).get();
    if (held) return toRecord(held);
    this.ids.clear();

    const service = connection.service;
    const vacant = LINKABLE_SERVICES.has(service)
      ? undefined
      : exec
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
      // Only a service that takes no agent gets here, so the channel starts with none.
      exec
        .update(channels)
        .set({ connectionId: connection.id, agent: null })
        .where(eq(channels.id, vacant.id))
        .run();
      return toRecord({ ...vacant, connectionId: connection.id, agent: null });
    }

    const wanted = named ?? (LINKABLE_SERVICES.has(service) ? undefined : service);
    const free =
      wanted !== undefined &&
      exec.select({ id: channels.id }).from(channels).where(eq(channels.id, wanted)).get() ===
        undefined;
    const id = free ? wanted : randomUUID();
    const row = {
      id,
      service,
      platform: platformOf(service, connection.domain),
      connectionId: connection.id,
      agent: LINKABLE_SERVICES.has(service) ? agent : null,
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
   * Link `agent` to channel `id`, or unlink it with null, and return the
   * channel as it now stands. Only channel `id` changes: an agent may be the
   * agent of any number of channels, several on one platform included. Main is
   * stored by its canonical id. Only a channel of a linkable service takes a
   * link; unlinking is always open.
   */
  link(id: string, requested: string | null): ChannelRecord {
    const agent = requested !== null && isCoreMainAgentId(requested) ? MAIN_AGENT_ID : requested;
    return this.db.transaction((tx) => {
      const row = tx.select().from(channels).where(eq(channels.id, id)).get();
      if (!row) throw new ChannelRecordNotFound(id);
      if (agent !== null && !LINKABLE_SERVICES.has(row.service)) {
        throw new ChannelNotLinkable(id, row.service);
      }
      if (agent !== null && row.connectionId === null) throw new ChannelUnbacked(id);
      tx.update(channels).set({ agent }).where(eq(channels.id, id)).run();
      return toRecord({ ...row, agent });
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
