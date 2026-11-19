import { z } from "zod";

export const CONTAINER_NODE_GRANT_LIFETIME_MS = 2 * 60 * 60_000;

export const containerNodeNameSchema = z.string().trim().min(1).max(80);

export const containerNodeListSchema = z.object({
  transport: z.enum(["direct", "cloud"]),
  nodes: z.array(
    z.object({
      id: z.uuid(),
      name: containerNodeNameSchema,
      deviceId: z.uuid().nullable(),
      status: z.enum(["waiting", "online", "offline", "needs_pairing", "unknown"]),
    }),
  ),
});
export type ContainerNode = z.infer<typeof containerNodeListSchema>["nodes"][number];

export const containerNodeGrantSchema = z.object({
  id: z.uuid(),
  installToken: z.string().regex(/^romeinstall_[A-Za-z0-9_-]{43}$/),
  expiresAt: z.iso.datetime(),
  origin: z.url({ protocol: /^https$/ }).nullable(),
});
export type ContainerNodeGrant = z.infer<typeof containerNodeGrantSchema>;

export const shellySwitchAddressSchema = z.object({ address: z.ipv4() }).strict();
export const shellySwitchStatusSchema = z.object({ on: z.boolean() });

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
      /** The device's own audit log. While unavailable, the device refuses remote actions. */
      audit: z
        .object({
          state: z.enum(["ok", "unavailable"]),
          code: z.string().optional(),
          message: z.string().optional(),
        })
        .optional(),
    }),
  ),
});
export type DevicesStatus = z.infer<typeof devicesStatusSchema>;

/**
 * The devices the caller is authorized for, read from Cloud's list. It sends
 * nothing to the devices, so it says nothing about who is online.
 */
export const deviceListSchema = z.object({
  devices: z.array(z.object({ id: z.string(), name: z.string(), platform: z.string().nullable() })),
});
export type DeviceList = z.infer<typeof deviceListSchema>;

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
 * Why renaming or removing a device failed. `revocation_pending` means the
 * device is revoked but Cloud still lists it until the Gateway confirms.
 */
export type DeviceManageErrorCode =
  | "device_not_found"
  | "invalid_device_name"
  | "revocation_pending"
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
