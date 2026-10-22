import {
  createNodeClient,
  nodeConfigFromEnvironment,
  CallerConfigurationError,
  DaemonVersionError,
  startDaemon,
} from "@rome-os/node-core/client";
import {
  deviceFilesResponseSchema,
  devicesStatusSchema,
  type DeviceFilesErrorCode,
  type DeviceFilesResponse,
  type DevicesStatus,
} from "@rome/api-types/devices";
import { withTracingSuppressed } from "../telemetry.js";

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
    "getDevicesStatus" | "run" | "disconnect"
  > = () => createNodeClient(nodeConfigFromEnvironment(process.env)),
  // Discovery is refused until the spawned daemon listens. A real failure rejects.
  start: () => Promise<unknown> = () =>
    withTracingSuppressed(() => startDaemon(nodeConfigFromEnvironment(process.env))),
) {
  let client: ReturnType<typeof createClient> | undefined;
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
    close: () => {
      client?.disconnect();
      client = undefined;
    },
  };
}
