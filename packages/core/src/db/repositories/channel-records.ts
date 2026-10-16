import { randomUUID } from "node:crypto";
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { platformOf } from "../../channels/platform.js";
import { channels } from "../schema.js";
import { inTransaction, type DrizzleDb, type DrizzleTx } from "../index.js";

/**
 * A channel a Connection backs, as stored: its id, the service and platform
 * it is on, and the Connection behind it now (null once that Connection is
 * gone). Vocabulary: docs/concepts/messaging.md#channels.
 */
export interface ChannelRecord {
  id: string;
  service: string;
  platform: string;
  connectionId: string | null;
  createdAt: Date;
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
    createdAt: row.createdAt,
  };
}

/**
 * The channels the Connections back.
 *
 * A channel's id is minted once and never changes, since every stored row
 * spells it. It is an opaque id, except that a service's first channel carries
 * the service's name, which is what data stored before channels were recorded
 * spells. A row stays when its Connection goes, and the service's next
 * Connection takes it back before a new id is minted.
 */
export class ChannelRecordsRepository {
  /** Channel id by Connection id, read on every port use. Every write
   *  empties it, and nothing is cached while a transaction is open, so a
   *  rolled-back write leaves no id behind. */
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
   * fresh opaque id otherwise.
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
      exec
        .update(channels)
        .set({ connectionId: connection.id })
        .where(eq(channels.id, vacant.id))
        .run();
      return toRecord({ ...vacant, connectionId: connection.id });
    }

    const serviceIdTaken =
      exec.select({ id: channels.id }).from(channels).where(eq(channels.id, service)).get() !==
      undefined;
    const row = {
      id: serviceIdTaken ? randomUUID() : service,
      service,
      platform: platformOf(service),
      connectionId: connection.id,
      createdAt: now,
    };
    exec.insert(channels).values(row).run();
    return toRecord(row);
  }

  /** Release the channel `connectionId` backs. The row and its id stay. */
  vacate(exec: Exec, connectionId: string): void {
    this.ids.clear();
    exec
      .update(channels)
      .set({ connectionId: null })
      .where(eq(channels.connectionId, connectionId))
      .run();
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
