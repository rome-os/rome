// What a device reports about its connections, and the state each one is in.
// Concept: docs/domains/connections.md#device-connection.

import { z } from "zod";

/** At most this many bytes in one report. */
export const MAX_REPORT_BYTES = 64 * 1024;

const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);

/**
 * One operation as the device's registry declares it. `description`, `input`
 * and `examples` came later and stay optional, so an older app's report still
 * validates.
 */
export const deviceOperationSchema = z.object({
  name: z.string().min(1).max(100),
  access: z.enum(["read", "write"]),
  /** What it does and how to call it, in English, for the Agent. */
  description: z.string().max(4000).optional(),
  /** The JSON schema of its arguments. */
  input: z.record(z.string(), z.unknown()).optional(),
  /** Argument objects that work as they are. */
  examples: z.array(z.record(z.string(), z.unknown())).max(10).optional(),
});

export type DeviceOperation = z.infer<typeof deviceOperationSchema>;

/** A language code as Rome names the guardian's, such as `en` or `zh-CN`. */
const language = z.string().regex(/^[a-z]{2}(-[A-Za-z0-9]{2,4})?$/);

/**
 * The words the guardian reads for a capability, in one language: its name
 * and what it lets Rome do, as its page on the device says them.
 */
export const deviceLabelSchema = z.object({
  title: z.string().min(1).max(100),
  summary: z.string().min(1).max(300).optional(),
});

export type DeviceLabel = z.infer<typeof deviceLabelSchema>;

/** One device's full list of connections, as `PUT /api/device-connections` takes it. */
export const deviceReportSchema = z.object({
  version: z.literal(1),
  device: z.object({
    id: z.string().min(1).max(100),
    name: z.string().max(100).optional(),
    platform: z.string().max(40).optional(),
    // The personal-data origin of the app install: the same across its
    // sign-ins, while `id` changes at each. Optional: older apps send none.
    originId: z.string().min(1).max(100).optional(),
  }),
  connections: z
    .array(
      z.object({
        capability: identifier,
        title: z.string().min(1).max(100),
        prefix: identifier,
        personal: z.boolean(),
        operations: z.array(deviceOperationSchema).max(100),
        permission: z.enum(["granted", "denied", "not_needed", "unknown"]),
        live: z.boolean(),
        // What the capability also syncs to, such as `apple_health`. Opaque
        // to connections.
        feeds: identifier.optional(),
        // What it lets Rome do, in English, as its page says. Optional: older
        // apps send none.
        summary: z.string().min(1).max(300).optional(),
        // The icon for its card, by a name the readers draw, such as
        // `calendar`. A name they do not draw shows none.
        icon: z.string().min(1).max(40).optional(),
        // Its name and summary in each language the device has them, so a
        // connect card reads in the guardian's language.
        labels: z
          .record(language, deviceLabelSchema)
          .refine((labels) => Object.keys(labels).length <= 8, "at most 8 languages")
          .optional(),
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
