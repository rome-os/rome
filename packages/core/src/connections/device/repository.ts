// The device connections' one way into the database. Concept:
// docs/domains/connections.md#device-connection.

import { and, asc, eq, inArray, notInArray } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { deviceConnections } from "../../db/schema/system.js";
import {
  type DeviceConnectionState,
  type DeviceLabel,
  type DeviceOperation,
  type DeviceReport,
  deviceConnectionId,
  deviceConnectionState,
  type Permission,
} from "./report.js";

/** A device connection as Rome lists it, its state computed on read. */
export interface DeviceConnection {
  id: string;
  device: { id: string; name: string | null; platform: string | null };
  /** The personal-data origin of the app install that reports it, or null. */
  originId: string | null;
  capability: string;
  title: string;
  prefix: string;
  personal: boolean;
  operations: DeviceOperation[];
  permission: Permission;
  live: boolean;
  /** What the capability also syncs to, as the device names it, or null. */
  feeds: string | null;
  /** What it lets Rome do, in English, as its page says, or null. */
  summary: string | null;
  /** Its name and summary by language, as the device has them. */
  labels: Record<string, DeviceLabel>;
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
          summary: connection.summary ?? null,
          labels: connection.labels ?? null,
          originId: report.device.originId ?? null,
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

  /**
   * Deletes a removed device's rows. Answers the origins no other device's
   * row still maps to: a sign-in again on the same app install reports
   * another device id with the same origin, which keeps it.
   */
  removeDevice(deviceId: string): { orphanedOrigins: string[] } {
    return this.db.transaction((tx) => {
      const origins = tx
        .selectDistinct({ originId: deviceConnections.originId })
        .from(deviceConnections)
        .where(eq(deviceConnections.deviceId, deviceId))
        .all()
        .flatMap((row) => (row.originId ? [row.originId] : []));
      tx.delete(deviceConnections).where(eq(deviceConnections.deviceId, deviceId)).run();
      if (origins.length === 0) return { orphanedOrigins: [] };
      const kept = new Set(
        tx
          .selectDistinct({ originId: deviceConnections.originId })
          .from(deviceConnections)
          .where(inArray(deviceConnections.originId, origins))
          .all()
          .map((row) => row.originId),
      );
      return { orphanedOrigins: origins.filter((origin) => !kept.has(origin)) };
    });
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
    originId: row.originId,
    capability: row.capability,
    title: row.title,
    prefix: row.prefix,
    personal: row.personal,
    operations: row.operations,
    permission: row.permission as Permission,
    live: row.live,
    feeds: row.feeds,
    summary: row.summary,
    labels: row.labels ?? {},
    state: deviceConnectionState(row),
    lastSeenAt: new Date(row.lastSeenAt).toISOString(),
  };
}
