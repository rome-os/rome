import {
  createNodeClient,
  nodeConfigFromEnvironment,
  CallerConfigurationError,
  DaemonVersionError,
  DeviceActionError,
  startDaemon,
} from "@rome-os/node-core/client";
import {
  deviceFilesResponseSchema,
  devicesStatusSchema,
  type DeviceList,
  type DeviceFilesErrorCode,
  type DeviceFilesResponse,
  type DeviceManageErrorCode,
  type DevicesStatus,
} from "@rome/api-types/devices";
import { withTracingSuppressed } from "../telemetry.js";

export type DeviceManageResult = { ok: true } | { ok: false; code: DeviceManageErrorCode };

const manageErrors = new Set<string>([
  "device_not_found",
  "invalid_device_name",
  "revocation_pending",
]);

export type DeviceFilesResult =
  | { ok: true; folder: DeviceFilesResponse }
  | { ok: false; code: DeviceFilesErrorCode };

const pathErrors = new Set<string>(["not_found", "not_a_directory", "permission_denied"]);

/** Maps an fs.list failure to what the folder picker can tell the guardian. */
function filesErrorCode(code: string): DeviceFilesErrorCode {
  if (code === "unsupported_action") return "upgrade_required";
  if (code === "target_unavailable") return "offline";
  return pathErrors.has(code) ? (code as DeviceFilesErrorCode) : "unavailable";
}

export function createNodeDevicesService(
  createClient: () => Pick<
    ReturnType<typeof createNodeClient>,
    "getDevicesStatus" | "listDevices" | "run" | "renameDevice" | "removeDevice" | "disconnect"
  > = () => createNodeClient(nodeConfigFromEnvironment(process.env)),
  // Discovery is refused until the spawned daemon listens. A real failure rejects.
  start: () => Promise<unknown> = () =>
    withTracingSuppressed(() => startDaemon(nodeConfigFromEnvironment(process.env))),
) {
  let client: ReturnType<typeof createClient> | undefined;
  async function manage(
    request: (client: ReturnType<typeof createClient>) => Promise<void>,
  ): Promise<DeviceManageResult> {
    try {
      client ??= createClient();
      await request(client);
      return { ok: true };
    } catch (error) {
      if (error instanceof DeviceActionError && manageErrors.has(error.code))
        return { ok: false, code: error.code as DeviceManageErrorCode };
      if (error instanceof DaemonVersionError) {
        client?.disconnect();
        client = undefined;
      }
      return { ok: false, code: "unavailable" };
    }
  }
  return {
    async start(): Promise<void> {
      await start();
    },
    async getStatus(): Promise<DevicesStatus> {
      try {
        client ??= createClient();
        const status = await client.getDevicesStatus();
        return status === null
          ? { connection: "not_running", checkedAt: new Date().toISOString(), devices: [] }
          : devicesStatusSchema.parse(status);
      } catch (error) {
        if (error instanceof DaemonVersionError) {
          client?.disconnect();
          client = undefined;
        }
        return {
          connection:
            error instanceof CallerConfigurationError && error.code === "not_configured"
              ? "not_configured"
              : error instanceof DaemonVersionError
                ? "incompatible"
                : "unavailable",
          checkedAt: new Date().toISOString(),
          devices: [],
        };
      }
    },
    /**
     * Authorized, unrevoked devices from Cloud's list. Unlike getStatus it sends
     * no probe to any device. Null when the caller cannot reach the list.
     */
    async listDevices(): Promise<DeviceList | null> {
      try {
        client ??= createClient();
        const list = await client.listDevices();
        return {
          devices: list.items
            .filter((item) => !item.revoked_at)
            .map((item) => ({
              id: item.id,
              name: typeof item.device_name === "string" ? item.device_name : item.id,
              platform: typeof item.platform === "string" ? item.platform : null,
            })),
        };
      } catch (error) {
        if (error instanceof DaemonVersionError) {
          client?.disconnect();
          client = undefined;
        }
        return null;
      }
    },
    /** Lists one folder on a device through its read-only `fs.list` action. */
    async listFiles(deviceId: string, path?: string): Promise<DeviceFilesResult> {
      try {
        client ??= createClient();
        const response = await client.run(deviceId, "fs.list", path ? { path } : {});
        if (!response.ok) return { ok: false, code: filesErrorCode(response.error.code) };
        const folder = deviceFilesResponseSchema.safeParse(response.result);
        return folder.success
          ? { ok: true, folder: folder.data }
          : { ok: false, code: "unavailable" };
      } catch (error) {
        if (error instanceof DaemonVersionError) {
          client?.disconnect();
          client = undefined;
        }
        return { ok: false, code: "unavailable" };
      }
    },
    /** Renames a device in the account through Cloud. */
    renameDevice(deviceId: string, name: string): Promise<DeviceManageResult> {
      return manage((c) => c.renameDevice(deviceId, name));
    },
    /** Revokes a device and deletes it from the account through Cloud. */
    removeDevice(deviceId: string): Promise<DeviceManageResult> {
      return manage((c) => c.removeDevice(deviceId));
    },
    close: () => {
      client?.disconnect();
      client = undefined;
    },
  };
}
