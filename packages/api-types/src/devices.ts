import { z } from "zod";

export const devicesStatusSchema = z.object({
  connection: z.enum([
    "not_running",
    "not_configured",
    "unavailable",
    "incompatible",
    "stopped",
    "connecting",
    "online",
    "retrying",
    "revoked",
    "superseded",
  ]),
  checkedAt: z.iso.datetime(),
  devices: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      platform: z.string().nullable(),
      status: z.enum(["connected", "not_connected", "unknown", "revoked"]),
    }),
  ),
});
export type DevicesStatus = z.infer<typeof devicesStatusSchema>;
