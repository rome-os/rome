// The device connections' one way into the database. Concept:
// docs/domains/connections.md#device-connection.

import { and, asc, eq, notInArray } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { deviceConnections } from "../../db/schema/system.js";
import {
  type DeviceConnectionState,
  type DeviceReport,
  deviceConnectionId,
  deviceConnectionState,
  type Permission,
} from "./report.js";

/** A device connection as Rome lists it, its state computed on read. */
export interface DeviceConnection {
  id: string;
  device: { id: string; name: string | null; platform: string | null };
  capability: string;
  title: string;
  prefix: string;
  personal: boolean;
  operations: { name: string; access: "read" | "write" }[];
  permission: Permission;
  live: boolean;
  /** What the capability also syncs to, as the device names it, or null. */
  feeds: string | null;
  state: DeviceConnectionState;
  lastSeenAt: string;
}

type Row = typeof deviceConnections.$inferSelect;

export class DeviceConnectionsRepository {
  constructor(private readonly db: DrizzleDb) {}

  /**
   * Replaces one device's rows with its report: a capability the report no
   * longer lists is removed, the others written as reported.
   */
  report(report: DeviceReport, now: number): DeviceConnection[] {
    const deviceId = report.device.id;
    const capabilities = report.connections.map((c) => c.capability);
    this.db.transaction((tx) => {
      tx.delete(deviceConnections)
        .where(
          and(
            eq(deviceConnections.deviceId, deviceId),
            capabilities.length > 0
              ? notInArray(deviceConnections.capability, capabilities)
              : undefined,
          ),
        )
        .run();
      for (const connection of report.connections) {
        const row = {
          deviceId,
          capability: connection.capability,
          deviceName: report.device.name ?? null,
          platform: report.device.platform ?? null,
          title: connection.title,
          prefix: connection.prefix,
          personal: connection.personal,
          operations: connection.operations,
          permission: connection.permission,
          live: connection.live,
          feeds: connection.feeds ?? null,
          lastSeenAt: now,
        };
        tx.insert(deviceConnections)
          .values(row)
          .onConflictDoUpdate({
            target: [deviceConnections.deviceId, deviceConnections.capability],
            set: row,
          })
          .run();
      }
    });
    return this.list().filter((c) => c.device.id === deviceId);
  }

  /** Every device's connections, by device, then capability. */
  list(): DeviceConnection[] {
    return this.db
      .select()
      .from(deviceConnections)
      .orderBy(asc(deviceConnections.deviceId), asc(deviceConnections.capability))
      .all()
      .map(toConnection);
  }

  /**
   * The connection whose device says its capability syncs to `feeds`: a
   * working one first, then the one heard from last. Undefined when none does.
   */
  feeding(feeds: string): DeviceConnection | undefined {
    const rank = { working: 0, off: 1, broken: 2 } as const;
    return this.db
      .select()
      .from(deviceConnections)
      .where(eq(deviceConnections.feeds, feeds))
      .all()
      .map(toConnection)
      .sort((a, b) => rank[a.state] - rank[b.state] || b.lastSeenAt.localeCompare(a.lastSeenAt))[0];
  }

  /** The connection with id `<deviceId>:<capability>`, or undefined. */
  byId(id: string): DeviceConnection | undefined {
    // A capability holds no colon, so the last one splits the id.
    const at = id.lastIndexOf(":");
    if (at <= 0) return undefined;
    const row = this.db
      .select()
      .from(deviceConnections)
      .where(
        and(
          eq(deviceConnections.deviceId, id.slice(0, at)),
          eq(deviceConnections.capability, id.slice(at + 1)),
        ),
      )
      .get();
    return row ? toConnection(row) : undefined;
  }
}

function toConnection(row: Row): DeviceConnection {
  return {
    id: deviceConnectionId(row.deviceId, row.capability),
    device: { id: row.deviceId, name: row.deviceName, platform: row.platform },
    capability: row.capability,
    title: row.title,
    prefix: row.prefix,
    personal: row.personal,
    operations: row.operations,
    permission: row.permission as Permission,
    live: row.live,
    feeds: row.feeds,
    state: deviceConnectionState(row),
    lastSeenAt: new Date(row.lastSeenAt).toISOString(),
  };
}
