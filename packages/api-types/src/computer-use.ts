import { z } from "zod";

export const computerUseConnectionSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  cli: z.literal("opencli"),
  status: z.enum(["connected", "disconnected", "unknown"]),
  version: z.string().nullable(),
  /** Last time Rome observed a live connection, not the daemon's initial handshake time. */
  lastSeenAt: z.iso.datetime().nullable(),
});

export const computerUseStatusSchema = z.object({
  daemon: z.object({
    status: z.enum(["running", "unavailable"]),
    version: z.string().nullable(),
  }),
  checkedAt: z.iso.datetime(),
  connections: z.array(computerUseConnectionSchema),
});

export type ComputerUseConnection = z.infer<typeof computerUseConnectionSchema>;
export type ComputerUseStatus = z.infer<typeof computerUseStatusSchema>;
