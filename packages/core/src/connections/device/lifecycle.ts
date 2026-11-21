// A device's lifecycle, as it reaches its connections: a device removed from
// the account through this Rome loses its rows. Rows leave no other way but
// the device's own empty report at sign-out; a device silent for 7 days is
// skipped, never deleted (live-route.ts). Personal data hears only of the
// origins a removal leaves with no install, through `turnOriginOff`. Concept:
// docs/domains/connections.md#device-connection.

import type { DeviceManageResult } from "../../desktops/node-devices.js";
import type { DeviceConnectionsRepository } from "./repository.js";

interface DeviceService {
  removeDevice(deviceId: string): Promise<DeviceManageResult>;
}

export interface DeviceLifecycleDeps {
  connections: () => Pick<DeviceConnectionsRepository, "removeDevice">;
  /** Turns off a personal-data origin whose install is gone. Its data stays. */
  turnOriginOff: (originId: string) => void;
}

/** The node devices service, with each removal applied to the device rows. */
export function withDeviceLifecycle<S extends DeviceService>(
  service: S,
  deps: DeviceLifecycleDeps,
): S {
  return {
    ...service,
    async removeDevice(deviceId: string) {
      const result = await service.removeDevice(deviceId);
      if (result.ok) {
        const { orphanedOrigins } = deps.connections().removeDevice(deviceId);
        for (const origin of orphanedOrigins) deps.turnOriginOff(origin);
      }
      return result;
    },
  };
}
