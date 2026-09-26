import {
  createNodeClient,
  nodeConfigFromEnvironment,
  CallerConfigurationError,
  DaemonVersionError,
} from "@rome-os/node-core/client";
import { devicesStatusSchema, type DevicesStatus } from "@rome/api-types/devices";

export function createNodeDevicesService(
  createClient: () => Pick<
    ReturnType<typeof createNodeClient>,
    "getDevicesStatus" | "disconnect"
  > = () => createNodeClient(nodeConfigFromEnvironment(process.env)),
) {
  let client: ReturnType<typeof createClient> | undefined;
  return {
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
    close: () => {
      client?.disconnect();
      client = undefined;
    },
  };
}
