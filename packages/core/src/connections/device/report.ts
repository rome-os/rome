// What a device reports about its connections, and the state each one is in.
// Concept: docs/domains/connections.md#device-connection.

import { z } from "zod";

/** At most this many bytes in one report. */
export const MAX_REPORT_BYTES = 64 * 1024;

const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);

/** One device's full list of connections, as `PUT /api/device-connections` takes it. */
export const deviceReportSchema = z.object({
  version: z.literal(1),
  device: z.object({
    id: z.string().min(1).max(100),
    name: z.string().max(100).optional(),
    platform: z.string().max(40).optional(),
  }),
  connections: z
    .array(
      z.object({
        capability: identifier,
        title: z.string().min(1).max(100),
        prefix: identifier,
        personal: z.boolean(),
        operations: z
          .array(z.object({ name: z.string().min(1).max(100), access: z.enum(["read", "write"]) }))
          .max(100),
        permission: z.enum(["granted", "denied", "not_needed", "unknown"]),
        live: z.boolean(),
        // What the capability also syncs to, such as `apple_health`. Opaque
        // to connections.
        feeds: identifier.optional(),
      }),
    )
    .max(50)
    .refine(
      (list) => new Set(list.map((c) => c.capability)).size === list.length,
      "each capability once",
    ),
});

export type DeviceReport = z.infer<typeof deviceReportSchema>;

export type Permission = DeviceReport["connections"][number]["permission"];

/**
 * Whether Agents can reach a device connection live: `broken` when the
 * device's permission is denied, `off` when its Live access switch is off,
 * `working` otherwise. A permission the device cannot tell (Apple Health's
 * read access) counts as given. Offline is not broken: whether the device
 * answers shows only when an Agent asks it.
 */
export type DeviceConnectionState = "working" | "off" | "broken";

export function deviceConnectionState(row: {
  permission: string;
  live: boolean;
}): DeviceConnectionState {
  if (row.permission === "denied") return "broken";
  return row.live ? "working" : "off";
}

/** A device connection's id: `<deviceId>:<capability>`. */
export function deviceConnectionId(deviceId: string, capability: string): string {
  return `${deviceId}:${capability}`;
}
