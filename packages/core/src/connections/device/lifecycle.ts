// A device's lifecycle, as it reaches its connections: a device removed from
// the account through this Rome loses its rows. Rows leave no other way but
// the device's own empty report at sign-out; a device silent for 7 days is
// skipped, never deleted (live-route.ts). Personal data hears only of the
// origins a removal leaves with no install, through `turnOriginOff`. Concept:
// docs/domains/connections.md#device-connection.

import type { DeviceList } from "@rome/api-types/devices";
import type { DeviceManageResult } from "../../desktops/node-devices.js";
import type { DeviceConnectionsRepository } from "./repository.js";

interface DeviceService {
  removeDevice(deviceId: string): Promise<DeviceManageResult>;
  listDevices(): Promise<DeviceList | null>;
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
  const listed = async (deviceId: string) =>
    (await service.listDevices())?.devices.some((device) => device.id === deviceId);
  return {
    ...service,
    /** A removal whose answer was lost counts as done when Cloud listed the
     *  device before and lists it no more. */
    async removeDevice(deviceId: string) {
      const before = await listed(deviceId);
      let result = await service.removeDevice(deviceId);
      if (
        !result.ok &&
        result.code === "unavailable" &&
        before &&
        (await listed(deviceId)) === false
      )
        result = { ok: true };
      if (result.ok) {
        const { orphanedOrigins } = deps.connections().removeDevice(deviceId);
        for (const origin of orphanedOrigins) deps.turnOriginOff(origin);
      }
      return result;
    },
  };
}
