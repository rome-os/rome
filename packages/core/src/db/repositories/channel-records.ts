import { randomUUID } from "node:crypto";
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { platformOf } from "../../channels/platform.js";
import { channels } from "../schema.js";
import type { DrizzleDb, DrizzleTx } from "../index.js";

/**
 * A channel a Connection backs, as stored: its name, the service and platform
 * it is on, and the Connection behind it now (null once that Connection is
 * gone). Vocabulary: docs/concepts/messaging.md#channels.
 */
export interface ChannelRecord {
  name: string;
  service: string;
  platform: string;
  connectionId: string | null;
  createdAt: Date;
}

type Exec = DrizzleDb | DrizzleTx;

function toRecord(row: typeof channels.$inferSelect): ChannelRecord {
  return {
    name: row.name,
    service: row.service,
    platform: row.platform,
    connectionId: row.connectionId,
    createdAt: row.createdAt,
  };
}

/**
 * The channels the Connections back.
 *
 * A channel's name is minted once and never changes, since every stored row
 * spells it. It is an opaque id, except that a service's first channel carries
 * the service's name, which is what data stored before channels were recorded
 * spells. A row stays when its Connection goes, and the service's next
 * Connection takes it back before a new name is minted.
 */
export class ChannelRecordsRepository {
  /** Channel name by Connection id, read on every port use. Emptied by every
   *  write, so a rolled-back mint costs a re-read rather than a wrong name. */
  private readonly names = new Map<string, string | null>();

  constructor(private readonly db: DrizzleDb) {}

  all(): ChannelRecord[] {
    return this.db.select().from(channels).orderBy(asc(channels.createdAt)).all().map(toRecord);
  }

  byName(name: string): ChannelRecord | null {
    const row = this.db.select().from(channels).where(eq(channels.name, name)).get();
    return row ? toRecord(row) : null;
  }

  /** The service behind channel `name`, or `name` itself when no channel
   *  records it: a service's first channel carries the service's name. */
  serviceOf(name: string): string {
    return this.byName(name)?.service ?? name;
  }

  /** The name of the channel `connectionId` backs, or null for none. */
  nameOf(connectionId: string): string | null {
    let name = this.names.get(connectionId);
    if (name === undefined) {
      name = this.byConnection(connectionId)?.name ?? null;
      this.names.set(connectionId, name);
    }
    return name;
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
    this.names.clear();

    const service = connection.service;
    const vacant = exec
      .select()
      .from(channels)
      .where(and(eq(channels.service, service), isNull(channels.connectionId)))
      .all()
      .sort(
        (a, b) =>
          Number(b.name === service) - Number(a.name === service) ||
          a.createdAt.getTime() - b.createdAt.getTime(),
      )[0];
    if (vacant) {
      exec
        .update(channels)
        .set({ connectionId: connection.id })
        .where(eq(channels.name, vacant.name))
        .run();
      return toRecord({ ...vacant, connectionId: connection.id });
    }

    const serviceNameTaken =
      exec
        .select({ name: channels.name })
        .from(channels)
        .where(eq(channels.name, service))
        .get() !== undefined;
    const row = {
      name: serviceNameTaken ? randomUUID() : service,
      service,
      platform: platformOf(service),
      connectionId: connection.id,
      createdAt: now,
    };
    exec.insert(channels).values(row).run();
    return toRecord(row);
  }

  /** Release the channel `connectionId` backs. The row and its name stay. */
  vacate(exec: Exec, connectionId: string): void {
    this.names.clear();
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
