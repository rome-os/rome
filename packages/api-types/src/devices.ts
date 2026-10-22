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

/** One folder on a device, as `fs.list` reports it. */
export const deviceFilesResponseSchema = z.object({
  /** Real path, symlinks resolved. */
  path: z.string(),
  /** Null at the filesystem root. */
  parent: z.string().nullable(),
  entries: z.array(
    z.object({ name: z.string(), type: z.enum(["dir", "file", "symlink", "other"]) }),
  ),
  /** The folder holds more entries than the device sent. */
  truncated: z.boolean(),
});
export type DeviceFilesResponse = z.infer<typeof deviceFilesResponseSchema>;

/**
 * Why a device folder could not be listed. `offline` and `upgrade_required`
 * describe the device; the rest describe the path.
 */
export type DeviceFilesErrorCode =
  | "offline"
  | "upgrade_required"
  | "not_found"
  | "not_a_directory"
  | "permission_denied"
  | "unavailable";

/**
 * The folder a chat works in on a rome-node device. The name and platform are
 * a snapshot taken when the chat was created.
 */
export const deviceFolderSchema = z.object({
  deviceId: z.string().min(1),
  deviceName: z.string(),
  platform: z.string().nullable(),
  path: z.string().min(1),
});
export type DeviceFolder = z.infer<typeof deviceFolderSchema>;
